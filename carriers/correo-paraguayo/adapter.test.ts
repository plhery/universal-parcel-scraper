import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CORREO_PARAGUAYO_API, CorreoParaguayoTracker } from './adapter.js';
import { correoParaguayoUrl, normalizeCorreoParaguayoNumber, parseCorreoParaguayo } from './parser.js';
import { correoParaguayoStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a registered item from Malaysia that Correo Paraguayo listed for an office.
const ITEM = 'RN219954910MY';
const UNKNOWN = 'RR999999995PY';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
// The sample's record with these fields changed.
const record = (fields: Record<string, unknown>) => JSON.stringify([{ ...(JSON.parse(fixture('planillado')) as object[])[0], ...fields }]);
// The endpoint serves its JSON as HTML.
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

describe('Correo Paraguayo tracking adapter', () => {
  it('asks the endpoint once for the whole code, as the tracker page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('planillado')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreoParaguayoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' rn 219 954 910 my ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORREO_PARAGUAYO_API}?id_envio=${ITEM}`);
    expect(String(url)).toBe(correoParaguayoUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json, text/plain, */*', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correo-paraguayo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the entry and the dispatch sheet newest first, on Paraguay\'s clock, without the addressee', () => {
    const result = parseCorreoParaguayo(fixture('planillado'), ITEM);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PLANILLADO', last_update: '2025-01-14T07:22:41-03:00', expected_delivery: null, weight_kg: 0.05, events: [
        { time: '2025-01-14T07:22:41-03:00', location: 'CTPN', description: 'Planillado: SALTOS DEL GUAIRA', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { time: '2025-01-09T12:48:47-03:00', description: 'Ingreso', stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|298334/);
  });

  it('dates a later status by the record\'s update and keeps one it cannot map visible', () => {
    const result = parseCorreoParaguayo(record({ estado: 'ENTREGADO', actualizacion: '2025-01-20 10:05:00.120', dependencia: 'SALTOS DEL GUAIRA' }), ITEM);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'ENTREGADO', last_update: '2025-01-20T10:05:00-03:00' });
    expect(result.events![0]).toEqual({ time: '2025-01-20T10:05:00-03:00', location: 'SALTOS DEL GUAIRA', description: 'ENTREGADO' });
    // An update no later than the steps dates nothing.
    expect(parseCorreoParaguayo(record({ estado: 'ENTREGADO' }), ITEM).events).toHaveLength(2);
  });

  it('reads a record not yet on a dispatch sheet, without a weight', () => {
    const result = parseCorreoParaguayo(record({ estado: 'INGRESADO', fechaplanillado: null, responsable: null, peso: '0.0000' }), ITEM);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'INGRESADO', last_update: '2025-01-09T12:48:47-03:00' });
    expect(result.weight_kg).toBeUndefined();
    expect(result.events).toEqual([expect.objectContaining({ description: 'Ingreso' })]);
  });

  it('reads the message for a code the endpoint holds nothing for as not found', async () => {
    expect(() => parseCorreoParaguayo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).recognize!(UNKNOWN))
      .resolves.toMatchObject({ known: false });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('planillado')))).recognize!(ITEM))
      .resolves.toMatchObject({ known: true });
  });

  it('refuses another item, a message for another code, invalid records and clocks, and a block page', () => {
    expect(() => parseCorreoParaguayo(fixture('planillado'), 'RN219954923MY')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo(fixture('not-found'), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo('{"mensaje":"Error de conexion"}', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo('[]', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo('[null]', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo(record({ estado: '' }), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo(record({ ingreso: '2025-02-30 12:48:47.656' }), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo(record({ fechaplanillado: '14/01/2025' }), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreoParaguayo(record({ ingreso: null, fechaplanillado: null }), ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseCorreoParaguayo(BLOCKED, ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCorreoParaguayo('<html><title>Correo</title></html>', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps redirects, missing routes and rate limits apart from a missing item, and retries a network failure once', async () => {
    for (const status of [302, 404]) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', status, { Location: '/' }))).track({ number: ITEM }))
        .rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', 429))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('planillado')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes S10 codes with a valid check digit and refuses anything else before a request', async () => {
    expect(normalizeCorreoParaguayoNumber('rn219954910my')).toBe(ITEM);
    expect(normalizeCorreoParaguayoNumber('RR 999 999 995 PY')).toBe(UNKNOWN);
    for (const bad of ['RN219954911MY', 'RN21995491MY', '1234567890', 'X'.repeat(65)]) {
      expect(() => normalizeCorreoParaguayoNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'RN219954911MY' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(correoParaguayoStage(entry.wording.split(': ')[0]!) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'correo-paraguayo', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
