import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, GintracomTracker, gintracomLookupUrl, gintracomPageUrl, normalizeGintracomNumber, parseGintracom } from './adapter.js';
import { gintracomStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/guia-7000793965.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

type Reply = typeof sample;
const NUMBER = sample.guia;
const LOOKUP = gintracomLookupUrl();
// The label is dated 27 January 2025; the tracker answered with rows to 13 February.
const NOW = Date.parse('2025-03-01T12:00:00Z');
const copy = (): Reply => structuredClone(sample);
const capture = (data: unknown = sample, extra: Record<string, unknown> = {}) => ({ url: LOOKUP, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'gintracom-reply', url = gintracomPageUrl(NUMBER), statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new GintracomTracker(environment, () => NOW) };
}

describe('Gintracom tracker', () => {
  it('reads the label’s guide: packed, out for delivery, unanswered and returned to the shop', () => {
    const result = parseGintracom(sample, NUMBER, NOW);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: 'Dev. entregada a origen', last_update: '2025-02-13T11:28:00-05:00', expected_delivery: null,
      destination_country: 'EC', timezone: 'America/Guayaquil' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('unread_estimates');
    expect(result.events!.map(({ time, provider_code, stage }) => [time, provider_code, stage])).toEqual([
      ['2025-02-13T11:28:00-05:00', 'devolucion', 'returned'],
      ['2025-02-12T09:16:00-05:00', 'devolucion', 'returned'],
      ['2025-02-05T03:02:00-05:00', 'devolucion', 'returned'],
      ['2025-01-29T08:50:00-05:00', 'contacto', 'failed_attempt'],
      ['2025-01-29T06:00:00-05:00', 'reparto', 'out_for_delivery'],
      ['2025-01-28T09:43:00-05:00', 'inicio', 'accepted'],
      ['2025-01-27T16:42:00-05:00', 'inicio', 'registered'],
    ]);
    expect(result.events![6]).toEqual({ time: '2025-01-27T16:42:00-05:00', time_zone: 'America/Guayaquil', time_zone_basis: 'carrier',
      description: 'Guía generada', provider_code: 'inicio', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.some((event) => 'local_time' in event)).toBe(false);
  });

  it('puts a yearless day in the latest year no later than the day after the lookup', () => {
    // Looked up on 1 January: a row of 31 December is last year's, one of 2 January too.
    const reply = copy();
    reply.historial = [{ texto: 'En reparto', fecha: '2 ene · 06:00', tipo: 'reparto' }, { texto: 'Guía generada', fecha: '31 dic · 16:42', tipo: 'inicio' }];
    const newYear = Date.parse('2026-01-01T12:00:00-05:00');
    expect(parseGintracom(reply, NUMBER, newYear).events!.map((event) => event.time)).toEqual(['2026-01-02T06:00:00-05:00', '2025-12-31T16:42:00-05:00']);
    expect(parseGintracom(reply, NUMBER, Date.parse('2025-12-31T23:00:00-05:00')).events!.map((event) => event.time))
      .toEqual(['2025-12-31T16:42:00-05:00', '2025-01-02T06:00:00-05:00']);
    reply.historial = [{ texto: 'Guía generada', fecha: '29 feb · 10:00', tipo: 'inicio' }];
    expect(parseGintracom(reply, NUMBER, newYear).events![0]!.time).toBe('2024-02-29T10:00:00-05:00');
    reply.historial = [{ texto: 'Guía generada', fecha: '27 ene 2024 · 16:42', tipo: 'inicio' }];
    expect(parseGintracom(reply, NUMBER, newYear).events![0]!.time).toBe('2024-01-27T16:42:00-05:00');
    for (const fecha of ['27/01 · 16:42', '27 xyz · 16:42', '32 ene · 16:42', '27 ene · 24:00', '27 ene', '']) {
      reply.historial = [{ texto: 'Guía generada', fecha, tipo: 'inicio' }];
      expect(() => parseGintracom(reply, NUMBER, newYear), fecha).toThrow(SchemaError);
    }
  });

  it('stages a delivery, keeps a row it cannot stage, and lists the date it does not read', () => {
    // Invented: the label's guide delivered on its second run, after a row the map does not know.
    const reply = copy() as unknown as Record<string, unknown>;
    reply.estado = { codigo: 'entregada', titulo: 'Entregada', texto: 'El pedido fue entregado.' };
    reply.etapa = 3;
    reply.fecha_clave = { etiqueta: 'Entregado', fecha: '30 ene' };
    reply.historial = [{ texto: 'Pedido entregado', fecha: '30 ene · 14:05', tipo: 'entregada' },
      { texto: 'Cliente pidió otro día', fecha: '29 ene · 09:10', tipo: 'reprogramada' }, ...sample.historial.slice(3)];
    const result = parseGintracom(reply, NUMBER, NOW);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Entregada',
      delivered_at: '2025-01-30T14:05:00-05:00', unread_estimates: ['fecha_clave'] });
    expect(result.events![1]).toEqual({ time: '2025-01-29T09:10:00-05:00', time_zone: 'America/Guayaquil', time_zone_basis: 'carrier',
      description: 'Cliente pidió otro día', provider_code: 'reprogramada' });
    // Only rows the map does not know: the progress rail decides.
    reply.historial = [{ texto: 'Cliente pidió otro día', fecha: '29 ene · 09:10', tipo: 'reprogramada' }];
    reply.estado = { codigo: 'reprogramada', titulo: 'Reprogramada' };
    reply.etapa = 1;
    expect(parseGintracom(reply, NUMBER, NOW)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    reply.etapa = null;
    expect(parseGintracom(reply, NUMBER, NOW)).toMatchObject({ status: 'unknown', last_status_text: 'Reprogramada' });
    expect(parseGintracom(reply, NUMBER, NOW)).not.toHaveProperty('current_stage');
  });

  it('keeps a repeated row once', () => {
    const reply = copy();
    reply.historial = [reply.historial[0]!, reply.historial[0]!, ...reply.historial.slice(1)];
    expect(parseGintracom(reply, NUMBER, NOW).events).toHaveLength(7);
  });

  it('answers only for the guide asked', () => {
    expect(() => parseGintracom(sample, '0000000001', NOW)).toThrow(IndeterminateError);
    expect(() => parseGintracom({ ...copy(), guia: '0000000001' }, NUMBER, NOW)).toThrow(IndeterminateError);
  });

  it('refuses a reply it cannot read', () => {
    const broken = (edit: (reply: Record<string, unknown>) => void) => { const reply = copy() as unknown as Record<string, unknown>; edit(reply); return reply; };
    expect(() => parseGintracom(null, NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(unknown, NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { delete reply.estado; }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.estado = { codigo: 'devuelta' }; }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.historial = null; }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.historial = Array(301).fill(sample.historial[0]); }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.etapa = 7; }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.historial = [{ fecha: '13 feb · 11:28', tipo: 'devolucion' }]; }), NUMBER, NOW)).toThrow(SchemaError);
    expect(() => parseGintracom(broken((reply) => { reply.historial = []; }), NUMBER, NOW)).toThrow(NoHistoryError);
  });

  it('takes a guide of letters and digits and refuses anything else before asking', async () => {
    expect(normalizeGintracomNumber(' 7000 793965 ')).toBe(NUMBER);
    expect(normalizeGintracomNumber('ab-12345')).toBe('AB12345');
    const h = harness();
    for (const number of ['70007', '7000793965700079396500', '7000/793965', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('gintracom');
  });

  it('asks the browser service for the tracker page and its bound lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'returned', last_update: '2025-02-13T11:28:00-05:00' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: 'https://ec.gintracom.site/tracking?guia=7000793965', skipHttp: true, maxTier: 3, captureResponses: [LOOKUP] });
    expect(adapter(h.environment)).toMatchObject({ id: 'gintracom', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an unknown guide as not found, a refused token as a challenge, and other answers as what they are', async () => {
    await expect(harness([capture(unknown, { status: 404 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture({ message: 'Not Found' }, { status: 404 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { status: 422, body: '', error: 'recaptcha-refused' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 422, body: '', error: 'recaptcha-refused' }), capture()]).tracker.fetch(NUMBER))
      .resolves.toMatchObject({ current_stage: 'returned' });
    await expect(harness([capture(null, { body: '', error: 'challenge-html' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture({ message: 'Datos inválidos' }, { status: 422 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 422 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(sample, { trackingNumberSubmitted: '0000000001' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture(), capture()]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(sample, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>', error: 'invalid-json' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], 'gintracom-reply', 'https://ec.gintracom.site/').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'gintracom-recaptcha-pictures').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'gintracom-capture_missing', undefined, 403).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'gintracom-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'gintracom-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new GintracomTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every status it has seen or the tracker names', () => {
    for (const entry of statuses.entries) {
      expect(gintracomStage(entry.code, entry.wording ?? entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'gintracom', providerCode: entry.code, description: entry.wording ?? entry.code }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(gintracomStage('inicio', 'Otra cosa')).toBeUndefined();
    expect(gintracomStage('contacto', 'Contacto con el cliente')).toBeUndefined();
  });
});
