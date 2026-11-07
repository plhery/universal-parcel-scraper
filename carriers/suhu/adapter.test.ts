import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SUHU_ACTION, SUHU_API, SUHU_PAGE, SuhuTracker } from './adapter.js';
import { normalizeSuhuNumber, parseSuhu, parseSuhuNonce } from './parser.js';
import { statusMap, suhuMappedStage, suhuStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const IN_TRANSIT = 'SUH0000000000002AB';
const LINE = 'JTDE000000000002';
const UNKNOWN = 'SUH0000000000001AB';
const NONCE = '0a1b2c3d4e';

type Row = Record<string, unknown>;
type Order = Row & { trackResponses: Row[] };
type Reply = { success: boolean; data: { data: Order[]; redirect?: string } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = <T = Reply>(name: string) => JSON.parse(text(`${name}.json`)) as T;
const PAGE = text('home-page.html');
/** The in-transit reply with its one order changed in place by `change`. */
const changed = (change: (order: Order) => void): Reply => {
  const reply = fixture('in-transit');
  change(reply.data.data[0]!);
  return reply;
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
/** A site that serves the home page, then `lookup` for the plugin's action. */
const site = (lookup: () => Response, page: () => Response = () => html(PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url) === SUHU_PAGE ? page() : lookup()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';

describe('Suhu Express HTTP adapter', () => {
  it('reads the nonce from the home page, then posts the whole number with it, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SuhuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' suh 0000-0000-00002 ab ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(pageUrl)).toBe(SUHU_PAGE);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(url)).toBe(SUHU_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ action: SUHU_ACTION, tracking_numbers: IN_TRANSIT, language: 'en', nonce: NONCE });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'suhu', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('takes the nonce from the tracking form’s settings and needs one', () => {
    expect(parseSuhuNonce(PAGE)).toBe(NONCE);
    expect(() => parseSuhuNonce(PAGE.replace(`"nonce":"${NONCE}"`, '"nonce":""'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuhuNonce(PAGE.replace('var suhuLogistics', 'var otherSettings'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuhuNonce(PAGE.replace('"nonce"', '"nonce":"0a1b2c3d4e" "x"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSuhuNonce(CLOUDFLARE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps each scan’s wall clock and place, newest first, staged by its code, and names the line in Germany', () => {
    const result = parseSuhu(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Accepted by last-mile carrier', last_update: null, last_update_local: '2026-03-16T09:33:00',
      destination_country: 'DE', delivery_carrier: 'j-and-t-de', delivery_tracking_number: LINE });
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2026-03-16T09:33:00', '3001', 'in_transit'],
      ['2026-03-14T15:42:00', '3099', 'in_transit'],
      ['2026-03-14T15:32:00', '2003', 'in_transit'],
      ['2026-03-14T15:03:16', '2008', 'customs'],
      ['2026-03-13T14:43:00', '2006', 'in_transit'],
      ['2026-03-13T09:35:00', '2005', 'in_transit'],
      ['2026-03-13T06:14:06', '2001', 'in_transit'],
      ['2026-03-12T19:00:00', '2003', 'in_transit'],
      ['2026-03-12T17:00:00', '2004', 'in_transit'],
      ['2026-03-11T06:14:06', '1099', 'in_transit'],
      ['2026-03-10T08:12:02', '1010', 'in_transit'],
      ['2026-03-10T05:20:28', '1009', 'in_transit'],
      ['2026-03-09T20:37:55', '1003', 'in_transit'],
      ['2026-03-09T16:59:15', '1002', 'accepted'],
      ['2026-03-07T09:25:59', '1004', 'registered'],
    ]);
    // Wordings lose the line break they end in; a scan without a place keeps none.
    expect(result.events![2]).toMatchObject({ description: 'Export clearance success', location: 'AMS' });
    expect(result.events![6]).not.toHaveProperty('location');
    expect(result.events![9]).toMatchObject({ location: 'South China Transit Center' });
    expect(result.events!.every((event) => event.time === undefined && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('keeps a scan listed twice once, and sorts scans listed oldest first', () => {
    const doubled = parseSuhu(changed((order) => order.trackResponses.push(order.trackResponses[0]!)), IN_TRANSIT);
    expect(doubled.events).toHaveLength(15);
    const reversed = parseSuhu(changed((order) => order.trackResponses.reverse()), IN_TRANSIT);
    expect(reversed).toMatchObject({ last_update_local: '2026-03-16T09:33:00' });
    expect(reversed.events![0]).toMatchObject({ provider_code: '3001' });
    expect(reversed.events!.at(-1)).toMatchObject({ provider_code: '1004' });
  });

  it('stages a code the map does not know by the shared wording rules, or not at all', () => {
    const delivered = parseSuhu(changed((order) => order.trackResponses.unshift(
      { Date: '2026/3/17 10:00:00', Position: 'DE', Content: 'Delivered', TrackCode: '3999' })), IN_TRANSIT);
    expect(delivered).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language' });
    const unknown = parseSuhu(changed((order) => order.trackResponses.unshift(
      { Date: '2026/3/17 10:00:00', Position: '', Content: 'Sample note', TrackCode: '3998' })), IN_TRANSIT);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Sample note' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('names no line when its number is the one asked or no high-confidence rule claims it', () => {
    expect(parseSuhu(fixture('in-transit'), LINE)).not.toHaveProperty('delivery_carrier');
    const unclaimed = parseSuhu(changed((order) => { order.trackNo = '00000000000000'; order.serviceNo = '00000000000000'; }), IN_TRANSIT);
    expect(unclaimed).not.toHaveProperty('delivery_carrier');
    expect(unclaimed).not.toHaveProperty('delivery_tracking_number');
  });

  it('reads the tracker’s answer for an unknown number as not found, and other refusals as inconclusive', () => {
    expect(() => parseSuhu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseSuhu({ success: false, data: { message: '错误信息：系统繁忙' } }, UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Suhu Express did not complete the lookup' }));
    expect(() => parseSuhu(changed((order) => { order.trackResponses = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseSuhu(changed((order) => { order.trackResponses = []; order.errorMsg = '订单异常'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Suhu Express answered the order with an error' }));
  });

  it('keeps only an order that names the whole number asked', () => {
    expect(() => parseSuhu(fixture('in-transit'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Suhu Express answered for another shipment' }));
    expect(parseSuhu(changed((order) => { order.orderNo = IN_TRANSIT.toLowerCase(); }), IN_TRANSIT).events).toHaveLength(15);
    expect(() => parseSuhu(changed((order) => { order.orderNo = `${IN_TRANSIT}9`; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ message: 'Suhu Express answered for another shipment' }));
  });

  it('rejects a changed reply', () => {
    const row = (change: (row: Row) => void) => changed((order) => change(order.trackResponses[0]!));
    for (const [index, reply] of [
      { success: 'true', data: fixture('in-transit').data },
      { success: true, data: [] },
      { success: true, data: { data: [] } },
      { success: true, data: { data: {} } },
      { success: true, data: { data: Array.from({ length: 21 }, () => fixture('in-transit').data.data[0]) } },
      changed((order) => { order.trackResponses = {} as unknown as Row[]; }),
      changed((order) => { order.trackResponses = Array.from({ length: 501 }, () => order.trackResponses[0]!); }),
      changed((order) => { order.trackResponses[0] = 'scan' as unknown as Row; }),
      row((scan) => { scan.Date = '2026-03-16 09:33:00'; }),
      row((scan) => { scan.Date = '2026/3/16 24:00:00'; }),
      row((scan) => { scan.Date = '2026/2/30 9:33:00'; }),
      row((scan) => { scan.Date = '2026/03/16 9:33:00'; }),
      row((scan) => { scan.Date = ''; }),
      row((scan) => { scan.Content = ' '; }),
    ].entries()) {
      expect(() => parseSuhu(reply, IN_TRANSIT), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused nonce, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: () => Response, page?: () => Response) => carrier(site(body, page)).track({ number: UNKNOWN });
    await expect(lookup(() => json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    // WordPress answers a nonce it does not accept with HTTP 403 and `-1`.
    await expect(lookup(() => html('-1', { status: 403 }))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'nonce_expired' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // An action no plugin registers is HTTP 400 and `0`; a 404 or a redirect is a move too.
    await expect(lookup(() => html('0', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: SUHU_PAGE } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 301, headers: { Location: 'https://suhusupplychain.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json(fixture('not-found')), () => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json(fixture('not-found')), () => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><title>SUHU</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json(fixture('not-found')), () => html('<html><title>SUHU</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s from the page and from the lookup', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      const fromPage = site(() => json(fixture('in-transit')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it('reads HTTP 403 from the page as a challenge', async () => {
    const fromPage = site(() => json(fixture('in-transit')), () => new Response('', { status: 403 }));
    await expect(carrier(fromPage).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('refuses what Suhu cannot look up, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['0000000', 'SAMPLETRACKING', `${IN_TRANSIT},${UNKNOWN}`, '0'.repeat(41), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeSuhuNumber(' suh 0000-0000-00002 ab ')).toBe(IN_TRANSIT);
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

  it('recognizes a number its tracker knows, and not one it does not', async () => {
    await expect(carrier(site(() => json(fixture('in-transit')))).recognize!(IN_TRANSIT, { budgetMs: 3000 }))
      .resolves.toMatchObject({ known: true });
    await expect(carrier(site(() => json(fixture('not-found')))).recognize!(UNKNOWN, { budgetMs: 3000 })).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('SUH-0')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('routes a number filed under Suhu to the adapter', async () => {
    const fetcher = site(() => json(fixture('in-transit')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: IN_TRANSIT, carrier: 'suhu' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'suhu', source: 'suhu', result: { current_stage: 'in_transit' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === SUHU_API)).toBe(true);
  });
});

describe('Suhu Express status vocabulary', () => {
  it('records every code the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string }[]) {
      expect(statusMapAnswer({ carrier: 'suhu', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(suhuStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
  });

  it('leaves an unknown code to the shared rules', () => {
    expect(statusMap.stage('3999', 'delivered')).toBeUndefined();
    expect(suhuMappedStage(null)).toBeUndefined();
    expect(suhuStage('3999', 'Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(suhuStage(null, 'Sample note')).toBeNull();
    expect(statusMapAnswer({ carrier: 'suhu', providerCode: '3998', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
