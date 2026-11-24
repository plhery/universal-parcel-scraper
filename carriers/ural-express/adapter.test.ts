import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, UralExpressTracker, URAL_LOOKUP } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeUralNumber, parseUral } from './parser.js';
import { statusMap, uralStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: the first delivered, the last listed without rows; and an invented number.
const DELIVERED = numbers.records[0]!.number;
const LISTED = numbers.records.at(-1)!.number;
const UNKNOWN = 'URA99999999ZPRU';

type Row = Record<string, unknown>;
type Shipment = Row & { tracks: Row[] };
type Reply = { code: number; success: boolean; message: string; data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture's reply with its one shipment changed in place by `change`. */
const changed = (change: (shipment: Shipment, reply: Reply) => void, name = 'delivered'): Reply => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Ural Express HTTP adapter', () => {
  it('posts the whole number as the page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UralExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${DELIVERED.toLowerCase().slice(0, 7)} ${DELIVERED.slice(7)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(URAL_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', Origin: 'https://tmsplus.ilinexpress.com', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init.body))).toEqual([DELIVERED]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ural-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each row’s wall clock, country and code, newest first, staged by its code', () => {
    const result = parseUral(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Отправление выдано', last_update: null, last_update_local: '2025-09-07T09:09:52', destination_country: 'RU' });
    for (const field of ['delivery_carrier', 'delivery_tracking_number', 'summary_only', 'provider_code']) expect(result).not.toHaveProperty(field);
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2025-09-07T09:09:52', 'Russia', 'TYP_SUCCESS', 'delivered'],
      ['2025-08-28T13:44:15', 'Russia', 'TYP_IN_DELIVERY_STATION', 'ready_for_pickup'],
      ['2025-08-25T11:39:46', 'Russia', 'TYP_THIRD_DELIVERING', 'in_transit'],
      ['2025-08-25T11:39:45', undefined, undefined, 'in_transit'],
      ['2025-08-12T17:06:30', 'Russia', 'TYP_OUT_CUSTOMS_CLEARANCE', 'in_transit'],
      ['2025-08-12T00:59:26', 'Russia', 'TYP_IN_CUSTOMS_CLEARANCE', 'customs'],
      ['2025-07-31T10:00:00', 'Russia', 'TYP_LAND_ARRIVE', 'in_transit'],
      ['2025-07-24T17:02:08', 'Russia', 'TYP_ID_DATA_COLLECTED', undefined],
      ['2025-07-24T10:00:00', 'Russia', 'TYP_LAND_START_ARRIVE', 'in_transit'],
      ['2025-06-17T10:00:00', 'Russia', 'TYP_LAND_TRANSFER_CUSTOMS', 'in_transit'],
      ['2025-06-16T19:14:00', 'Russia', 'TYP_LAND_PASS_BORDER', 'in_transit'],
      ['2025-05-27T18:02:00', 'Russia', 'TYP_LAND_ARRIVAL_BORDER', 'in_transit'],
      ['2025-05-27T10:04:00', 'Russia', 'TYP_LAND_EXPORT_DECLARATION', 'in_transit'],
      ['2025-05-26T17:02:45', 'Russia', 'TYP_LAND_BORDER_IN_BOUND', 'in_transit'],
      ['2025-05-24T11:04:00', 'Russia', 'TYP_LAND_LOADING', 'in_transit'],
      ['2025-05-23T08:34:35', 'China', 'TYP_COMPLETED_OUTBOUND_SCAN', 'in_transit'],
      ['2025-05-22T17:48:25', 'China', 'TYP_COMPLETED_INTBOUND_SCAN', 'accepted'],
      ['2025-05-21T04:11:23', 'China', 'TYP_THIRD_PICK_UP_SUCCESS', 'accepted'],
      ['2025-05-20T05:15:03', 'China', 'TYP_PRE_ORDER', 'registered'],
      ['2025-05-20T05:14:32', 'China', 'TYP_PRE_ORDER', 'registered'],
      ['2025-05-20T05:14:31', undefined, undefined, 'registered'],
      ['2025-05-20T00:14:31', undefined, undefined, 'registered'],
    ]);
    expect(result.events![3]).toMatchObject({ description: 'Передано в службу доставки', stage_source: 'carrier_map' });
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The marketplace's order number is never read.
    expect(JSON.stringify(result)).not.toContain(fixture('delivered').data[0]!.mailNo as string);
  });

  it('sorts rows by their clock, reads a row listed twice once, and leaves out a row without wording', () => {
    const reversed = parseUral(changed((shipment) => shipment.tracks.reverse()), DELIVERED);
    expect(reversed).toMatchObject({ last_update_local: '2025-09-07T09:09:52', current_stage: 'delivered' });
    expect(reversed.events!.map((event) => event.local_time)).toEqual(parseUral(fixture('delivered'), DELIVERED).events!.map((event) => event.local_time));
    const doubled = parseUral(changed((shipment) => shipment.tracks.push({ ...shipment.tracks[0]!, id: 1 })), DELIVERED);
    expect(doubled.events).toHaveLength(22);
    const blank = parseUral(changed((shipment) => shipment.tracks.unshift({ ...shipment.tracks[0]!, time: '2025-09-08 10:00:00', message: ' ' })), DELIVERED);
    expect(blank.events).toHaveLength(22);
  });

  it('lets a newer unstaged row keep the stage of the row before it, and the shared rules read an unknown code', () => {
    const note = parseUral(changed((shipment) => shipment.tracks.unshift({ ...shipment.tracks[1]!, time: '2025-09-08 10:00:00',
      status: 'TYP_SAMPLE', message: 'Sample note' })), DELIVERED);
    expect(note).toMatchObject({ last_status_text: 'Sample note', last_update_local: '2025-09-08T10:00:00' });
    expect(note.events![0]).not.toHaveProperty('stage');
    const worded = parseUral(changed((shipment) => shipment.tracks.splice(0, 1, { ...shipment.tracks[0]!, status: 'TYP_SAMPLE',
      message: 'Delivered' })), DELIVERED);
    expect(worded).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
  });

  it('reads a shipment listed without rows as listed, and an empty list as the tracker’s empty answer', () => {
    expect(() => parseUral(fixture('listed'), LISTED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseUral(changed((shipment) => { delete (shipment as Row).tracks; }, 'listed'), LISTED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseUral(fixture('not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
  });

  it('keeps only a shipment that names the whole number asked', () => {
    expect(() => parseUral(fixture('delivered'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Ural Express answered for another shipment' }));
    expect(() => parseUral(changed((shipment) => { shipment.tracks[2]!.waybillNum = UNKNOWN; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Ural Express answered for another shipment' }));
    expect(parseUral(changed((shipment) => { shipment.waybillNum = DELIVERED.toLowerCase(); }), DELIVERED).events).toHaveLength(22);
    // The shipment is picked by the number asked among several.
    const several = changed((shipment, reply) => { reply.data = [fixture('listed').data[0]!, shipment]; });
    expect(parseUral(several, DELIVERED).events).toHaveLength(22);
  });

  it('keeps refusals and changed replies apart', () => {
    expect(() => parseUral({ code: 500, data: null, message: 'Server internal error ', success: false }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseUral({ code: 429, data: null, message: '请求过于频繁', success: false }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseUral({ code: 200, data: [], message: '', success: false }, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const row = (change: (row: Row) => void) => changed((shipment) => change(shipment.tracks[0]!));
    for (const [index, reply] of [
      null,
      { code: '200', success: true, data: [] },
      { code: 200, success: true, data: {} },
      { code: 200, success: true, data: null },
      { code: 200, success: true, data: ['shipment'] },
      { code: 200, success: true, data: Array.from({ length: 21 }, () => fixture('delivered').data[0]) },
      changed((shipment) => { (shipment as Row).tracks = {}; }),
      changed((shipment) => { shipment.tracks = Array.from({ length: 301 }, () => shipment.tracks[0]!); }),
      changed((shipment) => { shipment.tracks[0] = 'row' as unknown as Row; }),
      changed((shipment) => { shipment.tracks[0]!.toCountry = 7; }),
      row((scan) => { scan.time = '2025-09-07T09:09:52'; }),
      row((scan) => { scan.time = '2025-02-30 09:09:52'; }),
      row((scan) => { scan.time = '2025-09-07 24:00:00'; }),
      row((scan) => { scan.time = null; }),
      row((scan) => { scan.message = 5; }),
      row((scan) => { scan.status = 600; }),
      row((scan) => { scan.status = 'success'; }),
      row((scan) => { scan.location = ['RU']; }),
    ].entries()) {
      expect(() => parseUral(reply, DELIVERED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://tmsplus.ilinexpress.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => new Response('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    await expect(lookup(() => new Response(CLOUDFLARE, { status: 403, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    // The tracking app's own page in place of the reply.
    await expect(lookup(() => new Response('<!DOCTYPE html><html><head><title>国际物流</title></head><body><div id=app></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
  });

  it('refuses what Ural Express does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['35226325-0125-1', DELIVERED.slice(0, -4), 'URA0863460ZPRU', 'URA086346070ZPRU', 'URB08634607ZPRU',
      'URA08634607ZPRUX', `${DELIVERED},${UNKNOWN}`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeUralNumber(` ura ${DELIVERED.slice(3, 11)}-${DELIVERED.slice(11).toLowerCase()} `)).toBe(DELIVERED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under Ural Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    const answer = await tracker.track({ number: DELIVERED, carrier: 'ural-express' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ural-express', source: 'ural-express', result: { current_stage: 'delivered' } });
    // The package details received again half a minute later are read once by the facade.
    expect(answer.result.events).toHaveLength(21);
    expect(fetcher.mock.calls.some(([url]) => String(url) === URAL_LOOKUP)).toBe(true);
  });
});

describe('Ural Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string | null }[]) {
      const answer = statusMapAnswer({ carrier: 'ural-express', providerCode: entry.code, description: entry.wording });
      if (entry.stage === null) {
        expect(answer, `${entry.code} ${entry.wording}`).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        expect(uralStage(entry.code ?? null, entry.wording)).toBeNull();
        continue;
      }
      expect(answer, `${entry.code} ${entry.wording}`).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(uralStage(entry.code ?? null, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('TYP_SAMPLE', 'delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'sample note')).toBeUndefined();
    expect(uralStage('TYP_SAMPLE', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(uralStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'ural-express', providerCode: 'TYP_SAMPLE', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
