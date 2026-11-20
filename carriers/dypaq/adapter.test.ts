import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DYPAQ_TRACKING, DypaqTracker } from './adapter.js';
import { dypaqRequestNumber } from './number.js';
import { parseDypaq } from './parser.js';
import { dypaqStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The guía of DYPAQ's API documentation, and an invented one it holds nothing for.
const DELIVERED = 'WK123578467';
const UNKNOWN = 'ZZ000000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Reply = { result: { delivery: { Descripcion: string; Valor: unknown }[]; tracking: Record<string, string>[] } } & Record<string, unknown>;
const reply = (name: string) => JSON.parse(text(name)) as Reply;
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('DYPAQ HTTP adapter', () => {
  it('posts the one guía to the tracking service, through the supplied transport', async () => {
    const fetcher = answering(() => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DypaqTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wk 123578467 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(DYPAQ_TRACKING);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init.body))).toEqual({ guia: DELIVERED });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dypaq', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first on its wall clocks, with its offices, and nothing about the recipient', () => {
    const result = parseDypaq(text('delivered'), DELIVERED);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Confirmacion de entrega', last_update: null, last_update_local: '2023-11-29T15:29:00', expected_delivery: null,
      events: [
        { local_time: '2023-11-29T15:29:00', description: 'Confirmacion de entrega', location: 'VERACRUZ', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2023-11-28T20:32:54', description: 'Embarque a ruta VER-04 [TUXTEPEC]', location: 'VERACRUZ', stage: 'out_for_delivery',
          stage_source: 'carrier_map' },
        { local_time: '2023-11-22T01:52:02', description: 'Embarcado a circuito PUEBLA - VERACRUZ', location: 'PUEBLA', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2023-11-22T00:04:25', description: 'Embarcado a circuito RECOLEC PUEBLA', location: 'PUEBLA', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2023-11-21T22:13:34', description: 'Recoleccion', location: 'PUEBLA', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2023-11-21T14:42:27', description: 'Envío PRE-Documentado en Sitio Web del Cliente', location: 'CIUDAD DE MEXICO',
          stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    for (const dropped of ['EJEMPLO', 'mapa', 'iVBOR', 'domicilio', '68300']) expect(JSON.stringify(result)).not.toContain(dropped);
  });

  it('keeps a wording no rule reads without a stage, a repeated movement once, and a reply without movements of its own apart', () => {
    const unread = reply('delivered');
    unread.result.tracking[0]!.Movimiento = 'Xyzzy';
    unread.result.tracking.push({ ...unread.result.tracking[1]! });
    const result = parseDypaq(JSON.stringify(unread), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'Xyzzy' });
    expect(result.events).toHaveLength(6);
    expect(result.events![0]).toEqual({ local_time: '2023-11-29T15:29:00', description: 'Xyzzy', location: 'VERACRUZ' });
    const other = reply('delivered');
    for (const row of other.result.tracking) row.GUIA = 'WK123578460';
    expect(() => parseDypaq(JSON.stringify(other), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = reply('delivered');
    mixed.result.tracking[0]!.GUIA = 'WK123578460';
    expect(parseDypaq(JSON.stringify(mixed), DELIVERED)).toMatchObject({ current_stage: 'out_for_delivery', events: expect.any(Array) });
  });

  it('reads the empty reply naming the guía as not found, and nothing else', async () => {
    expect(() => parseDypaq(text('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDypaq(text('not-found'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    await expect(carrier(answering(() => json(text('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('refuses a changed reply or clock, and reads a browser check as a challenge', () => {
    const changed = (edit: (body: Reply) => void) => {
      const body = reply('delivered');
      edit(body);
      return JSON.stringify(body);
    };
    expect(() => parseDypaq('{}', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDypaq(changed((body) => { body.return_code = 500; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDypaq(changed((body) => { body.errors = ['guia invalida']; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['2023-11-31T15:29:00', '2023-11-29T24:00:00', '29/11/2023 15:29', '2023-11-29', '']) {
      expect(() => parseDypaq(changed((body) => { body.result.tracking[0]!.FechaCaptura = clock; }), DELIVERED), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDypaq(changed((body) => { body.result.tracking[0]!.Movimiento = '<a href="x">Ver mapa</a>'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDypaq(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // No movements, under a block naming another guía, is no answer about this one.
    expect(() => parseDypaq(changed((body) => { body.result.tracking = []; body.result.delivery[0]!.Valor = 'WK000000000'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDypaq(changed((body) => { body.result.tracking = [null as never]; }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing guía', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => json(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('{}', { status: 429, headers: { 'Retry-After': '60' } }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => json({ code: 'rest_no_route' }, { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 301, headers: { Location: 'https://dypaq.com/' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks again once when DYPAQ cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new DypaqTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects input that is no guía, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'WK12345', 'WKABCDEFGHI', 'WK1235784é7', 'W'.repeat(21), '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known guía and an unknown one as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(text('delivered'))).mockResolvedValueOnce(json(text('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a guía filed under DYPAQ', async () => {
    const fetcher = answering(() => json(text('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'dypaq' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'dypaq', source: 'dypaq', result: { current_stage: 'delivered' } });
  });
});

describe('DYPAQ guías', () => {
  it('takes the guía in capitals without spaces or hyphens', () => {
    for (const number of [DELIVERED, 'wk123578467', 'WK 123 578 467', 'WK-123578467']) expect(dypaqRequestNumber(number)).toBe(DELIVERED);
  });

  it('claims no guía, so recognition never offers DYPAQ', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('dypaq');
    expect(recognitionCandidates(DELIVERED).map(({ carrier: id }) => id)).not.toContain('dypaq');
  });
});

describe('DYPAQ status vocabulary', () => {
  it('stages every recorded wording as the map does', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(dypaqStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'dypaq', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('x', 'Recoleccion')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dypaq', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});
