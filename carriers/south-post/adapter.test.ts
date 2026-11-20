import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { SouthPostTracker } from './adapter.js';
import { normalizeSouthPostNumber, parseSouthPost, parseSouthPostReply } from './parser.js';
import { southPostStage, statusMap } from './status.js';

// The public sample of numbers.json; its reply is the fixture.
const NUMBER = '556587';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
type Row = Record<string, unknown>;
const changed = (edit: (rows: Row[], reply: Row) => void) => { const data = fixture(); edit(data.data.guia.fechas, data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code?: string; wording: string; stage: string | null }[] };
// What the tracker answered an unknown number, with HTTP 500.
const FAILURE = { error: 'Error servidor Epresi' };
// One more scan on top of the fixture's, a day after its newest.
const then = (estado: string, extra: Row = {}) => changed(rows => {
  rows.unshift({ ...rows[0], fecha: '26/11/2020', hora: '10:30', estado, codigo_estado: 999, receptor_fecha_hora: '2020-11-26 10:30:00', receptor_nombre: ' ', ...extra });
});

describe('South Post guest adapter', () => {
  it('posts the whole number once as the page does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new SouthPostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(9);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://tracker.southpost.com.ar/seguimiento');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(String(init!.body))).toEqual({ nro_guia: NUMBER });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'south-post', step: 'direct', outcome: 'ok' }));
  });

  it('reads the public sample\'s scans newest first on Argentina\'s clock, dated by its first delivery', () => {
    const delivered = { stage: 'delivered', stage_source: 'carrier_map' };
    expect(parseSouthPost(fixture(), NUMBER)).toEqual({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADA', last_update: '2020-11-25T14:48:06-03:00', expected_delivery: null,
      delivered_at: '2020-11-21T13:57:18-03:00', signed_by: 'juan manuel l',
      events: [
        { time: '2020-11-25T14:48:06-03:00', description: 'ENTREGADA', provider_code: '39', ...delivered },
        { time: '2020-11-24T07:43:50-03:00', description: 'ENTREGADA', provider_code: '39', ...delivered },
        { time: '2020-11-21T13:57:18-03:00', description: 'ENTREGADA', provider_code: '39', ...delivered },
        { time: '2020-11-20T00:00:01-03:00', description: 'EN DISTRIBUCION', provider_code: '70', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2020-11-19T11:48:19-03:00', description: 'No Visitado', provider_code: '118' },
        { time: '2020-11-19T00:00:01-03:00', description: 'EN DISTRIBUCION', provider_code: '70', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2020-11-18T08:11:00-03:00', description: 'PROGRAMACION', provider_code: '138', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2020-11-18T07:59:00-03:00', description: 'PICKING', provider_code: '136', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2020-11-18T06:28:18-03:00', description: 'PENDIENTE DE STOCK', provider_code: '135', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    // The details beside a status are left out.
    const text = JSON.stringify(parseSouthPost(fixture(), NUMBER));
    for (const kept of ['RENDICION', 'PLANILLA', 'GENERACION']) expect(text).not.toContain(kept);
  });

  it('reads the minute of fecha and hora when the stamp beside them disagrees or is missing', () => {
    expect(parseSouthPost(changed(rows => { rows[0]!.receptor_fecha_hora = '2020-11-25 14:49:06'; }), NUMBER).last_update).toBe('2020-11-25T14:48:00-03:00');
    expect(parseSouthPost(changed(rows => { rows[0]!.receptor_fecha_hora = null; }), NUMBER).last_update).toBe('2020-11-25T14:48:00-03:00');
    expect(parseSouthPost(changed(rows => { rows[0]!.receptor_fecha_hora = '2020-11-24 14:48:06'; }), NUMBER).last_update).toBe('2020-11-25T14:48:00-03:00');
    // Argentina keeps UTC−03:00 all year.
    expect(parseSouthPost(changed(rows => { for (const row of rows) { row.fecha = '15/07/2026'; row.receptor_fecha_hora = null; } }), NUMBER).last_update).toBe('2026-07-15T14:48:00-03:00');
  });

  it('names who took the parcel from the delivery run, preferring the page\'s receptor', () => {
    expect(parseSouthPost(changed(rows => { rows[1]!.receptor = 'SYNTHETIC RECEIVER'; }), NUMBER).signed_by).toBe('juan manuel l');
    expect(parseSouthPost(changed(rows => { rows[2]!.receptor = 'SYNTHETIC RECEIVER'; }), NUMBER).signed_by).toBe('SYNTHETIC RECEIVER');
    expect(parseSouthPost(changed(rows => { rows[2]!.receptor_nombre = ' '; rows[0]!.receptor_nombre = 'SYNTHETIC'; }), NUMBER).signed_by).toBe('SYNTHETIC');
    expect(parseSouthPost(changed(rows => { rows[2]!.receptor_nombre = ' '; }), NUMBER).signed_by).toBeUndefined();
    const out = parseSouthPost(changed(rows => { rows.splice(0, 3); }), NUMBER);
    expect(out).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', last_status_text: 'EN DISTRIBUCION' });
    expect(out.delivered_at).toBeUndefined();
    expect(out.signed_by).toBeUndefined();
  });

  it('stages the page\'s problems and keeps those it does not explain without a stage', () => {
    expect(parseSouthPost(then('1° visita no responde.'), NUMBER)).toMatchObject({ current_stage: 'failed_attempt', last_status_text: '1° visita no responde.' });
    expect(parseSouthPost(then('DOMICILIO INCOMPLETO'), NUMBER)).toMatchObject({ current_stage: 'exception' });
    expect(parseSouthPost(then('Devuelto al remitente'), NUMBER)).toMatchObject({ current_stage: 'returned' });
    // On its way back to the central hub, the return is not done yet.
    expect(parseSouthPost(then('retornando a casa central'), NUMBER)).toMatchObject({ current_stage: 'exception' });
    const later = parseSouthPost(then('Retiro efectuado'), NUMBER);
    expect(later.events![0]).toEqual({ time: '2020-11-26T10:30:00-03:00', description: 'Retiro efectuado', provider_code: '999' });
    // A delivery under a newer unstaged status may have been undone.
    expect(later).toMatchObject({ status: 'unknown', last_status_text: 'Retiro efectuado' });
    expect(later.delivered_at).toBeUndefined();
    const long = changed(rows => { rows.push(...Array.from({ length: 120 }, () => ({ ...rows[8] }))); });
    expect(parseSouthPost(long, NUMBER)).toMatchObject({ history_truncated: true, events: expect.objectContaining({ length: 100 }) });
  });

  it('rejects a reply about another shipment or with an unreadable scan', () => {
    for (const data of [changed((_rows, reply) => { reply.nro_guia = '556588'; }), changed((_rows, reply) => { reply.nro_guia = 556587; }),
      changed((_rows, reply) => { delete reply.nro_guia; }), changed(rows => { rows[3]!.guia = 556588; }), changed(rows => { delete rows[3]!.guia; })]) {
      expect(() => parseSouthPost(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const data of [changed(rows => { rows[0]!.fecha = '2020-11-25'; }), changed(rows => { rows[0]!.fecha = '31/02/2020'; }), changed(rows => { rows[0]!.hora = '14'; }),
      changed(rows => { delete rows[0]!.hora; }), changed(rows => { rows[0]!.estado = ' '; }), changed(rows => { rows[0] = null as unknown as Row; }),
      changed((_rows, reply) => { (reply.data as Row).status = 'error'; }), changed((_rows, reply) => { ((reply.data as Row).guia as Row).fechas = []; }),
      changed((_rows, reply) => { ((reply.data as Row).guia as Row).fechas = {}; }), changed(rows => { rows.push(...Array(500).fill(rows[0])); }),
      null, [], {}, 'guia', { nro_guia: NUMBER }]) {
      expect(() => parseSouthPost(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    // A status code is kept only as a whole number.
    expect(parseSouthPost(changed(rows => { rows[0]!.codigo_estado = '39'; }), NUMBER).events![0]!.provider_code).toBeUndefined();
  });

  it('keeps the tracker\'s error as a failure, never as a missing shipment', async () => {
    expect(() => parseSouthPostReply(JSON.stringify(FAILURE), NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    // It answered an unknown number with HTTP 500, as it would its own outage.
    const failing = vi.fn<typeof fetch>().mockResolvedValue(response(FAILURE, 500, { 'content-type': 'application/json' }));
    await expect(new SouthPostTracker({ fetcher: failing }).fetch('000000')).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(failing).toHaveBeenCalledOnce();
    const ok = vi.fn<typeof fetch>().mockResolvedValue(response(FAILURE));
    await expect(new SouthPostTracker({ fetcher: ok }).fetch('000000')).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(() => parseSouthPostReply('<!doctype html><html><head><title>South Post</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSouthPostReply('<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [502, 'indeterminate'], [404, 'transport'], [410, 'transport'], [302, 'transport']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(status === 302 ? '' : {}, status, { 'retry-after': '60', ...(status === 302 ? { location: 'https://example.test/' } : {}) }));
    await expect(new SouthPostTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new SouthPostTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new SouthPostTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('stages each wording of statuses.json and explains each gap', () => {
    expect(statuses.entries).toHaveLength(44);
    for (const entry of statuses.entries) {
      const wording = normalizeStatusWording(entry.wording);
      if (entry.stage === null) {
        expect(southPostStage(entry.wording)).toBeUndefined();
        expect(statusGapNote(statusMap, entry.code ?? null, wording)).toEqual(expect.any(String));
      } else {
        expect(STAGES).toContain(entry.stage);
        expect(statusMap.stage(entry.code ?? null, wording)).toBe(entry.stage);
      }
    }
    expect(statusGapNote(statusMap, null, normalizeStatusWording('Recupero producto con faltante'))).toBeUndefined();
    expect(southPostStage('ENTREGADO')).toBeUndefined();
  });

  it('routes an explicit selection and offers no number rule', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const result = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'south-post', number: NUMBER });
    expect(result.source).toBe('south-post');
    expect(result.result.events).toHaveLength(9);
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('south-post');
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('south-post');
    for (const number of ['', '12345678', '55 6587', 'A556587', '556587.']) expect(() => normalizeSouthPostNumber(number)).toThrow();
    for (const number of [NUMBER, '1', '0556587']) expect(normalizeSouthPostNumber(` ${number} `)).toBe(number);
  });

  it('reads a status its map lacks by the shared wording rules', () => {
    expect(parseSouthPost(then('Intento de entrega fallido'), NUMBER)).toMatchObject({ current_stage: 'failed_attempt', current_stage_source: 'wording:language' });
  });
});
