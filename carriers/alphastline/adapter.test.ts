import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, ALPHASTLINE_API, AlphastlineTracker } from './adapter.js';
import { normalizeAlphastlineNumber, parseAlphastline } from './parser.js';
import { alphastlineMappedStage, alphastlineShipmentStage, alphastlineStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const KNOWN = 'AF999999999999999999981';
const UNKNOWN = 'AF999999999999999999980';
const LINE = '9200190000000000000009';
// 2026-01-03 09:36:34 on Beijing time.
const CREATED_AT = 1_767_404_194;

type Row = Record<string, unknown>;
type Shipment = Row & { detail: Row[] };
type Reply = { trackingData: { All: { arr: Shipment[] } } } & Row;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The awaiting-pickup reply with its one shipment changed in place by `change`. */
const changed = (change: (shipment: Shipment) => void): Reply => {
  const reply = fixture('awaiting-pickup');
  change(reply.trackingData.All.arr[0]!);
  return reply;
};
const scan = (seconds: number, description: string, node?: string): Row => ({
  operateTime: new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19).replace('T', ' '),
  operateDesc: description, ...(node ? { operateNode: node } : {}), operateTimestamp: String(seconds), operateStatus: '3',
});
/** The order shipped: a scan a day after its data arrived, the line's number and the shipped status. */
const shipped = () => changed((shipment) => {
  shipment.status = 'Sented';
  shipment.statusDesc = 'Shipped';
  shipment.mailNo = LINE;
  shipment.detail.unshift(scan(CREATED_AT + 86_400, 'Departed from the sorting center'));
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Alphastline HTTP adapter', () => {
  it('posts the whole number as the home page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('awaiting-pickup')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new AlphastlineTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${KNOWN.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(ALPHASTLINE_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', Origin: 'https://www.alphastline.com', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init.body))).toEqual({ language: 'en', erpOrderCode: [KNOWN] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'alphastline', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates a scan at its instant on the clock it is written in, staged by its node', () => {
    expect(parseAlphastline(fixture('awaiting-pickup'), KNOWN)).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'The electronic information of the goods has been received', last_update: '2026-01-03T09:36:34+08:00',
      destination_country: 'US',
      events: [{ time: '2026-01-03T09:36:34+08:00', description: 'The electronic information of the goods has been received',
        provider_code: 'Created', stage: 'registered', stage_source: 'carrier_map' }],
    });
  });

  it('reads a shipped order newest first, with the line’s number, once per scan', () => {
    const result = parseAlphastline(shipped(), KNOWN);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed from the sorting center',
      last_update: '2026-01-04T09:36:34+08:00', delivery_carrier: 'usps', delivery_tracking_number: LINE });
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage])).toEqual([
      ['2026-01-04T09:36:34+08:00', null, 'in_transit'],
      ['2026-01-03T09:36:34+08:00', 'Created', 'registered'],
    ]);
    const reply = shipped();
    reply.trackingData.All.arr[0]!.detail.reverse();
    reply.trackingData.All.arr[0]!.detail.push({ ...reply.trackingData.All.arr[0]!.detail[1]! });
    expect(parseAlphastline(reply, KNOWN).events).toEqual(result.events);
  });

  it('names no line when its number is the one asked or no high-confidence rule claims it', () => {
    for (const mailNo of [KNOWN, '00000000000000', '']) {
      const result = parseAlphastline(changed((shipment) => { shipment.mailNo = mailNo; }), KNOWN);
      expect(result, mailNo).not.toHaveProperty('delivery_carrier');
      expect(result, mailNo).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('takes the shipment’s status when it is further on than the scans', () => {
    const status = (value: string, change: (shipment: Shipment) => void = () => {}) => parseAlphastline(changed((shipment) => {
      shipment.status = value;
      change(shipment);
    }), KNOWN);
    expect(status('Sented')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(status('Finished')).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(status('Failed')).toMatchObject({ status: 'exception', current_stage: 'exception' });
    expect(status('Pending')).toMatchObject({ current_stage: 'registered' });
    // An unknown status leaves the scans to say.
    expect(status('Sample')).toMatchObject({ current_stage: 'registered', current_stage_source: 'carrier_map' });
    // A scan further on than the status keeps its stage; a delivery stands over an exception status.
    const ahead = (value: string, wording: string) => status(value, (shipment) => shipment.detail.unshift(scan(CREATED_AT + 3600, wording)));
    expect(ahead('ToPickuped', 'Departed from the sorting center')).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'wording:language' });
    expect(ahead('Failed', 'Delivered')).toMatchObject({ current_stage: 'delivered' });
    // A scan nothing stages keeps its wording, and the status or an older scan gives the stage.
    const note = ahead('ToPickuped', 'Sample note');
    expect(note).toMatchObject({ last_status_text: 'Sample note', current_stage: 'registered' });
    expect(note.events![0]).not.toHaveProperty('stage');
    expect(parseAlphastline(changed((shipment) => {
      shipment.status = 'Sample';
      shipment.detail = [scan(CREATED_AT, 'Sample note', 'Sample')];
    }), KNOWN)).toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
  });

  it('keeps the instant in UTC when the wall clock gives no zone’s offset, and a lone wall clock as one', () => {
    const time = (change: (row: Row) => void) => parseAlphastline(changed((shipment) => change(shipment.detail[0]!)), KNOWN);
    expect(time((row) => { row.operateTime = '2026-01-03 09:43:34'; })).toMatchObject({ last_update: '2026-01-03T01:36:34Z',
      events: [expect.objectContaining({ time: '2026-01-03T01:36:34Z' })] });
    expect(time((row) => { row.operateTime = '2026-01-04 01:36:34'; }).events![0]!.time).toBe('2026-01-03T01:36:34Z');
    expect(time((row) => { row.operateTime = ''; }).events![0]!.time).toBe('2026-01-03T01:36:34Z');
    expect(time((row) => { row.operateTime = '2026-01-03 01:36:34'; }).events![0]!.time).toBe('2026-01-03T01:36:34Z');
    expect(time((row) => { row.operateTimestamp = CREATED_AT; }).events![0]!.time).toBe('2026-01-03T09:36:34+08:00');
    const wall = time((row) => { delete row.operateTimestamp; });
    expect(wall).toMatchObject({ last_update: null, last_update_local: '2026-01-03T09:36:34' });
    expect(wall.events![0]).toMatchObject({ local_time: '2026-01-03T09:36:34' });
    expect(wall.events![0]).not.toHaveProperty('time');
  });

  it('orders a lone wall clock on Beijing time and lets no newer unstaged scan keep an older delivery', () => {
    const mixed = parseAlphastline(changed((shipment) => {
      shipment.status = 'Sented';
      const lone = scan(CREATED_AT + 86_400, 'Sample earlier note');
      delete lone.operateTimestamp;
      // Four hours before the next scan on Beijing time, four hours after it if read on UTC.
      lone.operateTime = '2026-01-04 08:36:34';
      shipment.detail = [scan(CREATED_AT + 97_200, 'Departed from the sorting center'), lone, scan(CREATED_AT, 'Order received', 'Created')];
    }), KNOWN);
    expect(mixed.events!.map((event) => event.description)).toEqual(['Departed from the sorting center', 'Sample earlier note', 'Order received']);
    const undone = parseAlphastline(changed((shipment) => {
      shipment.status = 'Sented';
      shipment.detail = [scan(CREATED_AT + 172_800, 'Sample note', 'Exception_Other'), scan(CREATED_AT + 86_400, 'Delivered', 'Delivered_Other')];
    }), KNOWN);
    expect(undone.current_stage).not.toBe('delivered');
    expect(undone.status).not.toBe('delivered');
    // The line's notice after a delivery moves nothing: the delivery stands over a lagging or Failed status.
    for (const status of ['Sented', 'Failed']) {
      expect(parseAlphastline(changed((shipment) => {
        shipment.status = status;
        shipment.detail = [scan(CREATED_AT + 172_800, 'EXPECTED DELIVERY DATE UPDATED', 'InTransit_Other'),
          scan(CREATED_AT + 86_400, 'Delivered', 'Delivered_Other'), scan(CREATED_AT, 'Order received', 'Created')];
      }), KNOWN), status).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'EXPECTED DELIVERY DATE UPDATED' });
    }
  });

  it('reads the tracker’s answer for an unknown number as not found, and other refusals as inconclusive', () => {
    expect(() => parseAlphastline(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = fixture('not-found');
    other.trackingData.All.arr[0]!.errMsg = 'System busy';
    expect(() => parseAlphastline(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const listed = fixture('not-found');
    listed.trackingData.All.arr[0]!.status = 'Failed';
    expect(() => parseAlphastline(listed, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseAlphastline(changed((shipment) => { shipment.detail = []; shipment.status = 'Pending'; }), KNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseAlphastline({ code: 429, message: 'Too many requests' }, KNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseAlphastline({ code: 500, msg: 'error' }, KNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only a shipment that names the whole number asked', () => {
    expect(() => parseAlphastline(fixture('awaiting-pickup'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Alphastline answered for another shipment' }));
    expect(() => parseAlphastline(changed((shipment) => { shipment.erpOrderCode = UNKNOWN; shipment.mailNo = KNOWN; }), KNOWN))
      .toThrow(expect.objectContaining({ message: 'Alphastline answered for another shipment' }));
    expect(parseAlphastline(changed((shipment) => { shipment.erpOrderCode = KNOWN.toLowerCase(); }), KNOWN).events).toHaveLength(1);
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((shipment) => change(shipment.detail[0]!));
    for (const [index, reply] of [
      [],
      { trackingData: {} },
      { trackingData: { All: { arr: [] } } },
      { trackingData: { All: { arr: ['entry'] } } },
      { trackingData: { All: { arr: Array.from({ length: 41 }, () => fixture('awaiting-pickup').trackingData.All.arr[0]) } } },
      changed((shipment) => { (shipment as Row).detail = {}; }),
      changed((shipment) => { shipment.detail = Array.from({ length: 301 }, () => shipment.detail[0]!); }),
      changed((shipment) => { shipment.detail[0] = 'scan' as unknown as Row; }),
      changed((shipment) => { shipment.status = 7; }),
      row((scan) => { scan.operateTime = '2026/01/03 09:36:34'; }),
      row((scan) => { scan.operateTime = '2026-02-30 09:36:34'; }),
      row((scan) => { scan.operateTimestamp = '1767404194000'; }),
      row((scan) => { scan.operateTimestamp = '-1'; }),
      row((scan) => { scan.operateTimestamp = 1.5; }),
      row((scan) => { scan.operateTime = ''; scan.operateTimestamp = ''; }),
      row((scan) => { scan.operateDesc = ' '; }),
      row((scan) => { scan.operateNode = 'Created node'; }),
    ].entries()) {
      expect(() => parseAlphastline(reply, KNOWN), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://www.alphastline.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>Alphastline</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: KNOWN })).rejects.toMatchObject({ kind });
  });

  it('refuses what Alphastline does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [LINE, 'AF99999999999999999998', 'AF9999999999999999999811', 'AB999999999999999999981', `${KNOWN},${UNKNOWN}`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: KNOWN }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeAlphastlineNumber(` ${KNOWN.toLowerCase()} `)).toBe(KNOWN);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: KNOWN }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('is offered by detection for its numbers, asked by recognition, and knows a number only when the tracker does', async () => {
    expect(detectCarrierMatch(KNOWN)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['alphastline']) });
    expect(recognitionAskedCarriers(KNOWN)).toContain('alphastline');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('awaiting-pickup')));
    await expect(carrier(fetcher).recognize!(KNOWN, { budgetMs: 3000 })).resolves.toMatchObject({ known: true });
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')))).recognize!(UNKNOWN, { budgetMs: 3000 }))
      .resolves.toEqual({ known: false });
    const idle = vi.fn<typeof fetch>();
    await expect(carrier(idle).recognize!(LINE)).resolves.toEqual({ known: false });
    expect(idle).not.toHaveBeenCalled();
  });

  it('routes a number filed under Alphastline to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('awaiting-pickup')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: KNOWN, carrier: 'alphastline' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'alphastline', source: 'alphastline', result: { current_stage: 'registered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === ALPHASTLINE_API)).toBe(true);
  });
});

describe('Alphastline status vocabulary', () => {
  it('records every node the map knows with the stage it gives, the scans with no node by their wording, and the line’s notices as gaps', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string; unmapped?: boolean; note?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'alphastline', providerCode: entry.code, description: entry.wording });
      if (entry.unmapped) {
        expect(answer, entry.wording).toEqual({ kind: 'intentional_gap', note: entry.note });
        expect(alphastlineStage(entry.code ?? null, entry.wording), entry.wording).toBeNull();
        continue;
      }
      expect(answer, entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
      expect(alphastlineStage(entry.code ?? null, entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    // A node decides over the wording of a scan with no node.
    expect(alphastlineStage('InTransit_Other', 'Electronic cargo information received')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('reads the collection as accepted and the scans on the way by their node, and the line’s notices move nothing', () => {
    const hour = 3600;
    const result = parseAlphastline(changed((shipment) => {
      shipment.status = 'Sented';
      shipment.detail.unshift(
        scan(CREATED_AT + 15 * hour, 'EXPECTED DELIVERY DATE UPDATED', 'InTransit_Other'),
        scan(CREATED_AT + 15 * hour, 'ELECTRONIC INFORMATION SUBMITTED BY SHIPPER', 'InTransit_Other'),
        scan(CREATED_AT + 14 * hour, 'ITEM DESPATCHED TO TRANSSHIPMENT HUB', 'InTransit_Other'),
        scan(CREATED_AT + 2 * hour, 'Item inbound in sorting center.', 'InTransit_Other'),
        scan(CREATED_AT + hour, 'Item has been collected', 'PickedUp_CollectedParcel'),
      );
    }), KNOWN);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'EXPECTED DELIVERY DATE UPDATED' });
    expect(result.events!.map((event) => [event.provider_code, event.stage ?? null])).toEqual([
      ['InTransit_Other', null],
      ['InTransit_Other', null],
      ['InTransit_Other', 'in_transit'],
      ['InTransit_Other', 'in_transit'],
      ['PickedUp_CollectedParcel', 'accepted'],
      ['Created', 'registered'],
    ]);
    // Collected while the order's status still awaits pickup: accepted.
    expect(parseAlphastline(changed((shipment) => {
      shipment.detail.unshift(scan(CREATED_AT + hour, 'Item has been collected', 'PickedUp_CollectedParcel'));
    }), KNOWN)).toMatchObject({ current_stage: 'accepted', current_stage_source: 'carrier_map' });
  });

  it('leaves an unknown node to the shared rules, and the shipment statuses to the shipment', () => {
    expect(statusMap.stage('Sample', 'Delivered')).toBeUndefined();
    expect(alphastlineMappedStage(null)).toBeUndefined();
    expect(alphastlineStage('Sample', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(alphastlineStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'alphastline', providerCode: 'Sample', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    expect(['Default', 'Pending', 'ToPickuped', 'Sented', 'Finished', 'Failed'].map(alphastlineShipmentStage))
      .toEqual([undefined, 'registered', 'registered', 'in_transit', 'delivered', 'exception']);
  });
});
