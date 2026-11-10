import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, KUAYUAN_API, KuayuanTracker } from './adapter.js';
import { normalizeKuayuanNumber, parseKuayuan } from './parser.js';
import { kuayuanMappedStage, kuayuanStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = '3ZZZ6010100001';
const UNKNOWN = '3ZZZ6010100002';
const LINE = 'ZS00000000001';

type Row = Record<string, unknown>;
type Shipment = Row & { track_detail_list: Row[] };
type Entry = { ask: number; code: string; message: string; data: Shipment };
type Reply = { code: number; message: string; data: { detail: Record<string, Entry[]> } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The in-transit reply with its one shipment changed in place by `change`. */
const changed = (change: (shipment: Shipment, entry: Entry) => void): Reply => {
  const reply = fixture('in-transit');
  const entry = reply.data.detail['']![0]!;
  change(entry.data, entry);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; Charset=utf8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Kuayuan Express HTTP adapter', () => {
  it('posts the whole number as the home page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new KuayuanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 3zzz 6010-100001 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(KUAYUAN_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init.body))).toMatchObject({ method: 'getTrackInfoOutside', param: { codes: IN_TRANSIT, noUserCode: '1' },
      lang: 'en_US', token: expect.any(String), timestamp: expect.any(Number) });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'kuayuan-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps each scan’s wall clock and place, newest first, staged by its code, and names China Post’s number', () => {
    const result = parseKuayuan(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '邮件离开处理中心【广州】', last_update: null, last_update_local: '2026-01-06T21:17:12',
      destination_country: 'CA', delivery_carrier: 'china-post', delivery_tracking_number: LINE });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-01-06T21:17:12', 'ND', 'in_transit'],
      ['2026-01-06T21:11:29', 'ND', 'in_transit'],
      ['2026-01-06T20:54:50', 'ND', 'in_transit'],
      ['2026-01-06T20:51:34', 'ND', 'in_transit'],
      ['2026-01-06T20:42:42', 'ND', 'in_transit'],
      ['2026-01-05T08:38:26', 'JH', 'in_transit'],
      ['2026-01-04T08:38:26', 'ECYDG', 'in_transit'],
      ['2026-01-03T16:38:26', 'ECKSBG', 'in_transit'],
      ['2026-01-03T04:38:26', 'AF', 'in_transit'],
      ['2026-01-02T22:38:26', 'DF', 'in_transit'],
      ['2026-01-02T22:14:19', 'AF', 'in_transit'],
    ]);
    // Places lose the spaces they end in.
    expect(result.events![5]).toMatchObject({ description: 'Submitted to the airline', location: '中国香港' });
    expect(result.events!.at(-1)).toMatchObject({ location: 'SHENZHEN' });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
    // The recipient's name and town and the customer's reference are not kept.
    expect(JSON.stringify(result)).not.toMatch(/Sample Recipient|Sample Town|000000000000001/);
  });

  it('keeps a scan listed twice once, and sorts scans listed oldest first', () => {
    const doubled = parseKuayuan(changed((shipment) => shipment.track_detail_list.push(shipment.track_detail_list[0]!)), IN_TRANSIT);
    expect(doubled.events).toHaveLength(11);
    const reversed = parseKuayuan(changed((shipment) => shipment.track_detail_list.reverse()), IN_TRANSIT);
    expect(reversed).toMatchObject({ last_update_local: '2026-01-06T21:17:12' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: 'AF', location: 'SHENZHEN' });
  });

  it('stages the codes the home page names, and leaves another code to the shared wording rules', () => {
    const scan = (code: string, content: string) => changed((shipment) => shipment.track_detail_list.unshift(
      { track_date: '2026-01-09 10:00:00', track_location: 'TORONTO', track_content: content, track_code: code }));
    expect(parseKuayuan(scan('CC', 'Sample delivery'), IN_TRANSIT)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseKuayuan(scan('UE', 'Sample return'), IN_TRANSIT)).toMatchObject({ current_stage: 'returned' });
    expect(parseKuayuan(scan('ZZ', 'Delivered'), IN_TRANSIT)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
    // A scan nothing stages keeps its wording; the newest staged scan gives the stage.
    const note = parseKuayuan(scan('ZZ', 'Sample note'), IN_TRANSIT);
    expect(note).toMatchObject({ last_status_text: 'Sample note', current_stage: 'in_transit' });
    expect(note.events![0]).not.toHaveProperty('stage');
    expect(parseKuayuan(changed((shipment) => { shipment.track_detail_list = [{ track_date: '2026-01-09 10:00:00', track_content: 'Sample note' }]; }), IN_TRANSIT))
      .toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
    // A newer scan nothing stages may have undone a delivery.
    const undone = parseKuayuan(changed((shipment) => shipment.track_detail_list.unshift(
      { track_date: '2026-01-10 10:00:00', track_location: 'TORONTO', track_content: 'Sample note', track_code: 'ZZ' },
      { track_date: '2026-01-09 10:00:00', track_location: 'TORONTO', track_content: 'Sample delivery', track_code: 'CC' })), IN_TRANSIT);
    expect(undone.current_stage).not.toBe('delivered');
    expect(undone.status).not.toBe('delivered');
  });

  it('names no line when its number is the one asked or no high-confidence rule claims it', () => {
    const own = parseKuayuan(changed((shipment) => { shipment.server_hawbcode = IN_TRANSIT; }), IN_TRANSIT);
    expect(own).not.toHaveProperty('delivery_carrier');
    expect(own).not.toHaveProperty('delivery_tracking_number');
    const unclaimed = parseKuayuan(changed((shipment) => { shipment.server_hawbcode = '00000000000000'; }), IN_TRANSIT);
    expect(unclaimed).not.toHaveProperty('delivery_carrier');
    expect(unclaimed).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the tracker’s answer for an unknown number as not found, and other refusals as inconclusive', () => {
    expect(() => parseKuayuan(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const chinese = fixture('not-found');
    chinese.data.detail['']![0]!.message = '轨迹信息不存在';
    expect(() => parseKuayuan(chinese, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = fixture('not-found');
    other.data.detail['']![0]!.message = '系统繁忙';
    expect(() => parseKuayuan(other, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKuayuan({ code: 500, message: '查询过于频繁' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseKuayuan({ code: 500, message: 'error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKuayuan(changed((shipment) => { shipment.track_detail_list = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps only a shipment that names the whole number asked', () => {
    expect(() => parseKuayuan(fixture('in-transit'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Kuayuan Express answered for another shipment' }));
    expect(() => parseKuayuan(changed((shipment) => { shipment.shipper_hawbcode = UNKNOWN; shipment.server_hawbcode = LINE; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'Kuayuan Express answered for another shipment' }));
    expect(parseKuayuan(changed((shipment) => { shipment.shipper_hawbcode = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(11);
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((shipment) => change(shipment.track_detail_list[0]!));
    for (const [index, reply] of [
      { code: '200', data: fixture('in-transit').data },
      { code: 200, data: { detail: {} } },
      { code: 200, data: { detail: { '': [] } } },
      { code: 200, data: { detail: { '': ['entry'] } } },
      { code: 200, data: { detail: { '': Array.from({ length: 21 }, () => fixture('in-transit').data.detail['']![0]) } } },
      changed((_, entry) => { entry.ask = 2; }),
      changed((_, entry) => { (entry as unknown as Row).data = []; }),
      changed((shipment) => { (shipment as Row).track_detail_list = {}; }),
      changed((shipment) => { shipment.track_detail_list = Array.from({ length: 301 }, () => shipment.track_detail_list[0]!); }),
      changed((shipment) => { shipment.track_detail_list[0] = 'scan' as unknown as Row; }),
      row((scan) => { scan.track_date = '2026/01/06 21:17:12'; }),
      row((scan) => { scan.track_date = '2026-02-30 21:17:12'; }),
      row((scan) => { scan.track_date = '2026-01-06 24:00:00'; }),
      row((scan) => { scan.track_date = ''; }),
      row((scan) => { scan.track_content = ' '; }),
      row((scan) => { scan.track_code = 'N D'; }),
      row((scan) => { scan.track_location = 7; }),
    ].entries()) {
      expect(() => parseKuayuan(reply, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://www.kuayuanexpress.com.cn/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response('<html><title>跨源速递</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
  });

  it('refuses what Kuayuan does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [LINE, 'ZZZZ6010100001', '3ZZZ601010000', '3ZZZ60101000011', `${IN_TRANSIT},${UNKNOWN}`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeKuayuanNumber(' 3zzz 6010-100001 ')).toBe(IN_TRANSIT);
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

  it('is offered by detection for its dated numbers, asked by recognition, and knows a number only when the tracker does', async () => {
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['kuayuan-express']) });
    expect(recognitionAskedCarriers(IN_TRANSIT)).toContain('kuayuan-express');
    // The four digits after the year must be a month and a day.
    for (const number of ['3ZZZ6130100001', '3ZZZ6013200001', '3ZZZ6000100001']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('kuayuan-express');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('in-transit')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT, { budgetMs: 3000 })).resolves.toMatchObject({ known: true });
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')))).recognize!(UNKNOWN, { budgetMs: 3000 }))
      .resolves.toEqual({ known: false });
    const idle = vi.fn<typeof fetch>();
    await expect(carrier(idle).recognize!(LINE)).resolves.toEqual({ known: false });
    expect(idle).not.toHaveBeenCalled();
  });

  it('routes a number filed under Kuayuan to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'kuayuan-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'kuayuan-express', source: 'kuayuan-express', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === KUAYUAN_API)).toBe(true);
  });
});

describe('Kuayuan Express status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'kuayuan-express', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(kuayuanStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code to the shared rules', () => {
    expect(statusMap.stage('ZZ', 'Delivered')).toBeUndefined();
    expect(kuayuanMappedStage(null)).toBeUndefined();
    expect(kuayuanStage('ZZ', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(kuayuanStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'kuayuan-express', providerCode: 'ZZ', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
