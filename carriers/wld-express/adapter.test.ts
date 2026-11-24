import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { noHistoryHandoff } from '../../core/catalog/handoff.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, WLD_API, WldTracker, wldToken } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizeWldNumber, parseWld } from './parser.js';
import { statusMap, wldMappedStage, wldStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, an invented number, the line's number in the sample's reply and a China Post number.
const RETURNED = numbers.records[0]!.number;
const UNKNOWN = 'WLDME9999999901';
const LINE = 'PBR33584524390017354012900';
const CHINA_POST = 'ZS00000000501';

type Row = Record<string, unknown>;
type Shipment = Row & { track_detail_list: Row[] };
type Entry = { ask: number; code: string; message: string; data: Shipment };
type Reply = { code: number; message: string; data: { detail: Record<string, Entry[]> } };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's reply with its one shipment changed in place by `change`. */
const changed = (change: (shipment: Shipment, entry: Entry) => void): Reply => {
  const reply = fixture('returned');
  const entry = reply.data.detail['']![0]!;
  change(entry.data, entry);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; Charset=utf8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('WLD Express HTTP adapter', () => {
  it('posts the whole number as the track query page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('returned')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new WldTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${RETURNED.toLowerCase().slice(0, 5)} ${RETURNED.slice(5)} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'returned' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(WLD_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    const body = JSON.parse(String(init.body)) as { timestamp: number; token: string };
    expect(body).toEqual({ method: 'getTrackInfoOutside', param: { codes: RETURNED, noUserCode: '1' },
      lang: 'en_US', token: wldToken(body.timestamp), timestamp: expect.any(Number) });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'wld-express', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('signs a request as the page’s script does for a guest', () => {
    expect(wldToken(1_700_000_000_000)).toBe('eaf049635e2d3bacedd6');
  });

  it('keeps each scan’s wall clock and place, newest first, staged by its code or the line’s wording', () => {
    const result = parseWld(fixture('returned'), RETURNED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map',
      last_status_text: '(return) returned to sender', last_update: null, last_update_local: '2026-08-07T18:05:26',
      destination_country: 'HU', delivery_tracking_number: LINE });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-08-07T18:05:26', 'TT', 'returned'],
      ['2026-08-07T18:04:26', 'ND', 'out_for_delivery'],
      ['2026-08-05T04:08:05', 'ND', 'in_transit'],
      ['2026-08-04T17:33:35', 'ND', 'in_transit'],
      ['2026-08-04T16:48:40', 'ND', 'in_transit'],
      ['2026-08-04T13:15:00', 'ND', 'in_transit'],
      ['2026-08-04T07:49:00', 'ND', 'in_transit'],
      ['2026-08-04T07:08:08', 'ND', 'in_transit'],
      ['2026-07-27T14:19:00', 'DD', 'ready_for_pickup'],
      ['2026-07-27T14:16:34', 'DD', 'ready_for_pickup'],
      ['2026-07-27T13:59:39', 'ND', 'failed_attempt'],
      ['2026-07-27T09:37:22', 'ND', 'in_transit'],
      ['2026-07-27T08:40:20', 'ND', 'out_for_delivery'],
      ['2026-07-25T01:21:02', 'ND', 'in_transit'],
      ['2026-07-24T20:52:16', 'ND', 'in_transit'],
      ['2026-07-18T00:09:49', 'IR', 'registered'],
    ]);
    // A line's "office|town" reads "office, town"; a scan without a place has none.
    expect(result.events![0]).toMatchObject({ location: 'budapesti 4. sz. operatív osztály, budapest' });
    expect(result.events![9]).not.toHaveProperty('location');
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps neither the recipient nor the customer’s reference', () => {
    const result = parseWld(changed((shipment) => { shipment.consignee_name = 'Sample Recipient'; shipment.shipp_to_location = 'Sample Town'; }), RETURNED);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
    const text = JSON.stringify(result);
    for (const field of ['Sample Recipient', 'Sample Town', 'SN260718001796']) expect(text).not.toContain(field);
  });

  it('keeps a scan listed twice once, and sorts scans listed oldest first', () => {
    const doubled = parseWld(changed((shipment) => shipment.track_detail_list.push(shipment.track_detail_list[0]!)), RETURNED);
    expect(doubled.events).toHaveLength(16);
    const reversed = parseWld(changed((shipment) => shipment.track_detail_list.reverse()), RETURNED);
    expect(reversed).toMatchObject({ last_update_local: '2026-08-07T18:05:26', current_stage: 'returned' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: 'IR' });
  });

  it('stages the codes the page names, and leaves another code and wording to the shared rules', () => {
    const scan = (code: string, content: string) => changed((shipment) => shipment.track_detail_list.unshift(
      { track_date: '2026-08-09 10:00:00', track_location: '', track_content: content, track_code: code }));
    expect(parseWld(scan('CC', 'Sample delivery'), RETURNED)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseWld(scan('CF', 'Sample attempt'), RETURNED)).toMatchObject({ current_stage: 'failed_attempt' });
    expect(parseWld(scan('ND', 'Delivered'), RETURNED)).toMatchObject({ current_stage: 'delivered', current_stage_source: 'wording:language' });
    // A scan nothing stages keeps its wording, and may have undone the return before it.
    const note = parseWld(scan('ZZ', 'Sample note'), RETURNED);
    expect(note).toMatchObject({ last_status_text: 'Sample note', status: 'unknown' });
    expect(note).not.toHaveProperty('current_stage');
    expect(note.events![0]).not.toHaveProperty('stage');
    expect(parseWld(changed((shipment) => { shipment.track_detail_list = [{ track_date: '2026-08-09 10:00:00', track_content: 'Sample note' }]; }), RETURNED))
      .toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
  });

  it('names the line’s carrier only when a high-confidence rule claims its number, and no line that is the number asked', () => {
    expect(parseWld(changed((shipment) => { shipment.server_hawbcode = CHINA_POST; }), RETURNED))
      .toMatchObject({ delivery_carrier: 'china-post', delivery_tracking_number: CHINA_POST });
    for (const line of [RETURNED, '', null, 'not a number']) {
      const result = parseWld(changed((shipment) => { shipment.server_hawbcode = line; }), RETURNED);
      expect(result, String(line)).not.toHaveProperty('delivery_tracking_number');
      expect(result, String(line)).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads the tracker’s answer for an unknown number as not found, and other refusals as inconclusive', () => {
    expect(() => parseWld(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const chinese = fixture('not-found');
    chinese.data.detail['']![0]!.message = '单号不存在';
    expect(() => parseWld(chinese, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // Another tenant's wording for a number without scans is not WLD's answer for a number it does not hold.
    for (const message of ['Trajectory Information does not exist', '系统繁忙', '']) {
      const other = fixture('not-found');
      other.data.detail['']![0]!.message = message;
      expect(() => parseWld(other, UNKNOWN), message).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // The answer must name the number asked.
    expect(() => parseWld(fixture('not-found'), RETURNED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWld({ code: 500, message: '查询过于频繁' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseWld({ code: 500, message: 'error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWld(changed((shipment) => { shipment.track_detail_list = []; }), RETURNED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('keeps only a shipment that names the whole number asked', () => {
    expect(() => parseWld(fixture('returned'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'WLD Express answered for another shipment' }));
    expect(() => parseWld(changed((shipment) => { shipment.shipper_hawbcode = UNKNOWN; }), RETURNED))
      .toThrow(expect.objectContaining({ message: 'WLD Express answered for another shipment' }));
    expect(parseWld(changed((shipment) => { shipment.shipper_hawbcode = RETURNED.toLowerCase(); }), RETURNED).events).toHaveLength(16);
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((shipment) => change(shipment.track_detail_list[0]!));
    for (const [index, reply] of [
      { code: '200', data: fixture('returned').data },
      { code: 200, data: { detail: {} } },
      { code: 200, data: { detail: { '': [] } } },
      { code: 200, data: { detail: { '': ['entry'] } } },
      { code: 200, data: { detail: { '': Array.from({ length: 21 }, () => fixture('returned').data.detail['']![0]) } } },
      changed((_, entry) => { entry.ask = 2; }),
      changed((_, entry) => { (entry as unknown as Row).data = []; }),
      changed((shipment) => { (shipment as Row).track_detail_list = {}; }),
      changed((shipment) => { shipment.track_detail_list = Array.from({ length: 301 }, () => shipment.track_detail_list[0]!); }),
      changed((shipment) => { shipment.track_detail_list[0] = 'scan' as unknown as Row; }),
      changed((shipment) => { shipment.country_code = 36; }),
      row((scan) => { scan.track_date = '2026/08/07 18:05:26'; }),
      row((scan) => { scan.track_date = '2026-02-30 18:05:26'; }),
      row((scan) => { scan.track_date = '2026-08-07 24:00:00'; }),
      row((scan) => { scan.track_date = ''; }),
      row((scan) => { scan.track_content = ' '; }),
      row((scan) => { scan.track_code = 'T T'; }),
      row((scan) => { scan.track_location = 7; }),
    ].entries()) {
      expect(() => parseWld(reply, RETURNED), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a refusal, a browser check and a broken reply apart', async () => {
    const lookup = (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response())).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(() => json('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 302, headers: { Location: 'https://wld-exp.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => new Response(CLOUDFLARE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    // The order system's own page in place of the reply.
    await expect(lookup(() => new Response('<!doctype html><html><head><title>toms</title></head></html>', { headers: { 'Content-Type': 'text/html' } })))
      .rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)('preserves HTTP %s as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: RETURNED })).rejects.toMatchObject({ kind });
  });

  it('refuses what WLD does not issue, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of [LINE, CHINA_POST, 'WLDM6071800028', 'WLDME607180002', 'WLDME60718000281', 'XLDME6071800028', `${RETURNED},${UNKNOWN}`, '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: RETURNED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeWldNumber(` wldme ${RETURNED.slice(5, 9)}-${RETURNED.slice(9)} `)).toBe(RETURNED);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: RETURNED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('routes a number filed under WLD Express to the adapter', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('returned')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: RETURNED, carrier: 'wld-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'wld-express', source: 'wld-express', result: { current_stage: 'returned' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === WLD_API)).toBe(true);
  });

  it('proposes the line’s number when a reply without scans names a claimed one', async () => {
    const result = Promise.resolve().then(() => parseWld(changed((shipment) => {
      shipment.track_detail_list = [];
      shipment.server_hawbcode = CHINA_POST;
    }), RETURNED));
    await expect(result.catch((error) => noHistoryHandoff('wld-express', RETURNED, error)))
      .resolves.toMatchObject({ carrier: 'china-post', number: CHINA_POST });
  });
});

describe('WLD Express status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'wld-express', providerCode: entry.code, description: entry.wording }), `${entry.code} ${entry.wording}`)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(wldStage(entry.code, entry.wording), `${entry.code} ${entry.wording}`).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code and wording to the shared rules', () => {
    expect(statusMap.stage('ZZ', 'delivered')).toBeUndefined();
    expect(wldMappedStage(null, 'sample note')).toBeUndefined();
    expect(wldStage('ND', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(wldStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'wld-express', providerCode: 'ZZ', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
