import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noHistoryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, XINGYUNYI_API, XingyunyiTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeXingyunyiNumber, parseXingyunyi } from './parser.js';
import { statusMap, xingyunyiMappedStage, xingyunyiStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples, an invented number, the line's number in the second sample's reply and a China Post number.
const IN_TRANSIT = numbers.records[0]!.number;
const DELIVERED = numbers.records[1]!.number;
const UNKNOWN = 'XYYEX9999999990YQ';
const LINE = '3698K793589001000931503';
const CHINA_POST = 'ZS00000000501';

type Row = Record<string, unknown>;
type Shipment = Row & { TrackingLogs: Row[] };
type Reply = { code: number; success: boolean; message: string; data: Shipment[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture's reply with its one shipment changed in place by `change`. */
const changed = (change: (shipment: Shipment, reply: Reply) => void, name = 'in-transit'): Reply => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('XingYunYi HTTP adapter', () => {
  it('posts the whole number with the page’s token, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new XingyunyiTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${IN_TRANSIT.toLowerCase().slice(0, 5)} ${IN_TRANSIT.slice(5)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(XINGYUNYI_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Authorization: expect.stringMatching(/^token [0-9A-F]{32}$/), 'Content-Type': 'application/json',
      Origin: 'https://www.xingyunyi.com', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(JSON.parse(String(init.body))).toEqual({ Numbers: [IN_TRANSIT] });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xingyunyi', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and place, newest first, staged by its wording', () => {
    const result = parseXingyunyi(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Item was released from customs.', last_update: null, last_update_local: '2025-04-02T16:04:00',
      destination_country: 'GB' });
    for (const field of ['delivery_tracking_number', 'delivery_carrier', 'summary_only', 'provider_code']) expect(result).not.toHaveProperty(field);
    expect(result.events!.map((event) => [event.local_time, event.location, event.provider_code, event.stage])).toEqual([
      ['2025-04-02T16:04:00', 'GB', '4', 'in_transit'],
      ['2025-04-02T04:33:00', 'GB', '4', 'customs'],
      ['2025-03-31T11:40:00', 'CN', '4', 'in_transit'],
      ['2025-03-30T14:07:00', 'CN', '4', 'in_transit'],
      ['2025-03-29T22:53:50', '广州', '4', 'in_transit'],
      ['2025-03-29T16:28:38', '广州', '2', 'accepted'],
      ['2025-03-25T16:10:52', '广州', '1', 'registered'],
    ]);
    expect(result.events![4]).toMatchObject({ description: 'Item outbound in sorting center.',
      original_description: '广州 , Item outbound in sorting center.' });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps a row without its place prefix as written, a scan listed twice once, and sorts scans by their clock', () => {
    const unprefixed = parseXingyunyi(changed((shipment) => { shipment.TrackingLogs[0]!.StatusString = 'Item was released from customs.'; }), IN_TRANSIT);
    expect(unprefixed.events![0]).toMatchObject({ location: 'GB', description: 'Item was released from customs.' });
    expect(unprefixed.events![0]).not.toHaveProperty('original_description');
    const doubled = parseXingyunyi(changed((shipment) => shipment.TrackingLogs.push(shipment.TrackingLogs[0]!)), IN_TRANSIT);
    expect(doubled.events).toHaveLength(7);
    const reversed = parseXingyunyi(changed((shipment) => shipment.TrackingLogs.reverse()), IN_TRANSIT);
    expect(reversed).toMatchObject({ last_update_local: '2025-04-02T16:04:00', current_stage: 'in_transit' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: '1' });
  });

  it('keeps a clock the row states with its offset as an instant', () => {
    const result = parseXingyunyi(changed((shipment) => shipment.TrackingLogs.unshift(
      { TriggerTime: '2025-04-03T09:15:00.1230472+01:00', Location: 'GB', Status: 4, StatusString: 'GB , Sample scan' })), IN_TRANSIT);
    expect(result.events![0]).toMatchObject({ time: '2025-04-03T09:15:00+01:00', description: 'Sample scan' });
    expect(result.events![0]).not.toHaveProperty('local_time');
    expect(result).toMatchObject({ last_update: '2025-04-03T09:15:00+01:00', last_update_local: null });
  });

  it('reads a delivered order whose line no longer answers as a summary, without the line’s row', () => {
    // Australia Post's rule claims the line's number.
    const result = parseXingyunyi(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: 'Delivered', last_status_text: 'Delivered', last_update: null, summary_only: true,
      destination_country: 'AU', delivery_carrier: 'australia-post', delivery_tracking_number: LINE, events: [] });
  });

  it('lets the page’s Delivered decide when the last scan does not, and leaves other statuses to the scans', () => {
    const delivered = parseXingyunyi(changed((shipment) => { shipment.LatestLogisticsStatus = 'Delivered'; }), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'Delivered',
      last_status_text: 'Delivered', last_update_local: '2025-04-02T16:04:00' });
    expect(delivered.events).toHaveLength(7);
    expect(parseXingyunyi(changed((shipment) => { shipment.LatestLogisticsStatus = 'Exception'; }), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', last_status_text: 'Item was released from customs.' });
    // A scan nothing stages keeps its wording, and the stage stays with the scan before it.
    const note = parseXingyunyi(changed((shipment) => shipment.TrackingLogs.unshift(
      { TriggerTime: '2025-04-03T09:15:00', Location: 'GB', Status: 4, StatusString: 'GB , Sample note' })), IN_TRANSIT);
    expect(note).toMatchObject({ last_status_text: 'Sample note', current_stage: 'in_transit' });
    expect(note.events![0]).not.toHaveProperty('stage');
    expect(parseXingyunyi(changed((shipment) => shipment.TrackingLogs.unshift(
      { TriggerTime: '2025-04-03T09:15:00', Location: 'GB', Status: 16, StatusString: 'GB , Delivered' })), IN_TRANSIT))
      .toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
  });

  it('drops the line’s not-found row from a history that has scans', () => {
    const result = parseXingyunyi(changed((shipment) => shipment.TrackingLogs.unshift(
      { TriggerTime: '2026-11-25T01:08:11.1230472+08:00', Location: '', Status: 8, StatusString: ' , Not Found' })), IN_TRANSIT);
    expect(result.events).toHaveLength(7);
    expect(result).toMatchObject({ last_update_local: '2025-04-02T16:04:00', last_status_text: 'Item was released from customs.' });
  });

  it('reads an order without scans as listed, unless the page’s status says more than Transit', async () => {
    for (const state of ['Transit', 'InfoReceived', 'NotFound', '', null]) {
      expect(() => parseXingyunyi(changed((shipment) => { shipment.LatestLogisticsStatus = state; }, 'delivered'), DELIVERED), String(state))
        .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError', reason: 'listed' }));
    }
    for (const [state, stage] of [['Pickup', 'ready_for_pickup'], ['Delivery', 'out_for_delivery'], ['Failed', 'failed_attempt'],
      ['UnDelivered', 'failed_attempt'], ['Exception', 'exception']] as const) {
      expect(parseXingyunyi(changed((shipment) => { shipment.LatestLogisticsStatus = state; }, 'delivered'), DELIVERED), state)
        .toMatchObject({ current_stage: stage, provider_code: state, summary_only: true });
    }
    // An order listed without a scan still proposes a claimed line's number.
    const listed = Promise.resolve().then(() => parseXingyunyi(changed((shipment) => {
      shipment.LatestLogisticsStatus = 'Transit';
      shipment.TrackingNumber = CHINA_POST;
    }, 'delivered'), DELIVERED));
    await expect(listed.catch((error) => noHistoryHandoff('xingyunyi', DELIVERED, error)))
      .resolves.toMatchObject({ carrier: 'china-post', number: CHINA_POST });
  });

  it('names the line’s carrier only when a high-confidence rule claims its number, and no line that is the number asked', () => {
    expect(parseXingyunyi(changed((shipment) => { shipment.TrackingNumber = CHINA_POST; }), IN_TRANSIT))
      .toMatchObject({ delivery_carrier: 'china-post', delivery_tracking_number: CHINA_POST });
    for (const line of [IN_TRANSIT, '', null, 'not a number']) {
      const result = parseXingyunyi(changed((shipment) => { shipment.TrackingNumber = line; }), IN_TRANSIT);
      expect(result, String(line)).not.toHaveProperty('delivery_tracking_number');
      expect(result, String(line)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('keeps a number without an order inconclusive, and other refusals apart', () => {
    expect(() => parseXingyunyi(fixture('not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    // The empty order must name the number asked.
    expect(() => parseXingyunyi(fixture('not-found'), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'XingYunYi answered for another shipment' }));
    // An order without its id that carries scans or XingYunYi's number is a changed reply.
    expect(() => parseXingyunyi(changed((shipment) => { shipment.Id = 0; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXingyunyi(changed((shipment) => { shipment.SystemNo = UNKNOWN; }, 'not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXingyunyi({ code: 500, success: false, message: '查询过于频繁' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseXingyunyi({ code: 500, success: false, message: 'error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXingyunyi({ code: 200, success: false, message: 'error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps only an order that names the whole number asked', () => {
    expect(() => parseXingyunyi(fixture('in-transit'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'XingYunYi answered for another shipment' }));
    expect(() => parseXingyunyi(changed((shipment) => { shipment.SystemNo = UNKNOWN; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'XingYunYi answered for another shipment' }));
    expect(() => parseXingyunyi(changed((shipment) => { delete shipment.SystemNo; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'XingYunYi answered for another shipment' }));
    expect(parseXingyunyi(changed((shipment) => { shipment.SystemNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(7);
    // The shipment is picked by the number asked among several.
    const several = changed((shipment, reply) => { reply.data = [fixture('not-found').data[0]!, shipment]; });
    expect(parseXingyunyi(several, IN_TRANSIT).events).toHaveLength(7);
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((shipment) => change(shipment.TrackingLogs[0]!));
    for (const [index, reply] of [
      { code: '200', success: true, data: fixture('in-transit').data },
      { code: 200, success: true, data: {} },
      { code: 200, success: true, data: [] },
      { code: 200, success: true, data: ['shipment'] },
      { code: 200, success: true, data: Array.from({ length: 21 }, () => fixture('in-transit').data[0]) },
      changed((shipment) => { shipment.Id = '226262286'; }),
      changed((shipment) => { shipment.Id = -1; }),
      changed((shipment) => { (shipment as Row).TrackingLogs = {}; }),
      changed((shipment) => { shipment.TrackingLogs = Array.from({ length: 301 }, () => shipment.TrackingLogs[0]!); }),
      changed((shipment) => { shipment.TrackingLogs[0] = 'scan' as unknown as Row; }),
      changed((shipment) => { shipment.ReceiverCountryCode = 36; }),
      changed((shipment) => { shipment.LatestLogisticsStatus = 4; }),
      row((scan) => { scan.TriggerTime = '2025/04/02 16:04:00'; }),
      row((scan) => { scan.TriggerTime = '2025-02-30T16:04:00'; }),
      row((scan) => { scan.TriggerTime = '2025-04-02T24:00:00'; }),
      row((scan) => { scan.TriggerTime = '2025-04-02T16:04:00+25:00'; }),
      row((scan) => { scan.TriggerTime = ''; }),
      row((scan) => { scan.StatusString = 'GB , '; }),
      row((scan) => { scan.StatusString = null; }),
      row((scan) => { scan.Status = '4'; }),
      row((scan) => { scan.Location = 7; }),
    ].entries()) {
      expect(() => parseXingyunyi(reply, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://www.xingyunyi.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The service's refusal of a request with another token.
    await expect(lookup(() => new Response('Status Code: 403; Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge', reason: 'api_denied' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    // The site's own page in place of the reply.
    await expect(lookup(() => new Response('<!DOCTYPE html><html><head><title>行运易物流</title></head><body><div id=app></div></body></html>',
      { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
  });

  it('refuses what XingYunYi does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [LINE, CHINA_POST, IN_TRANSIT.slice(0, -2), 'XYYEX003560756YQ', 'XYYEX00356075680YQ', 'XYZEX0035607568YQ',
      `${IN_TRANSIT},${UNKNOWN}`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeXingyunyiNumber(` xyyex ${IN_TRANSIT.slice(5, 10)}-${IN_TRANSIT.slice(10)} `)).toBe(IN_TRANSIT);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under XingYunYi to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'xingyunyi' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'xingyunyi', source: 'xingyunyi', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === XINGYUNYI_API)).toBe(true);
  });
});

describe('XingYunYi status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string | null }[]) {
      const answer = statusMapAnswer({ carrier: 'xingyunyi', providerCode: entry.code, description: entry.wording });
      if (entry.stage === null) {
        expect(answer, `${entry.code} ${entry.wording}`).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(answer, `${entry.code} ${entry.wording}`).toEqual({ kind: 'mapped', stage: entry.stage });
      if (/^\d+$/.test(entry.code)) expect(xingyunyiStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('4', 'delivered')).toBeUndefined();
    expect(xingyunyiMappedStage(null, 'sample note')).toBeUndefined();
    expect(xingyunyiStage('Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(xingyunyiStage('Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'xingyunyi', providerCode: '4', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
