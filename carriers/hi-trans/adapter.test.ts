import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, HiTransTracker, hiTransSummaryUrl } from './adapter.js';
import { normalizeHiTransNumber, parseHiTrans } from './parser.js';
import { hiTransStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json.
const DELIVERED = 'ETS188';
const ON_BOARD = 'MTX833';
const UNKNOWN = 'ZZZ0000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const CHECK = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
/** The summary for a number: each sample's page, and the not-found page for any other. */
const summary = (number: string) => [DELIVERED, ON_BOARD].includes(number) ? fixture(number) : fixture('not-found').replace(UNKNOWN, number);
const numberOf = (url: unknown) => new URL(String(url)).searchParams.get('Number')!;
const direct = () => vi.fn<typeof fetch>(async url => page(summary(numberOf(url))));
const carrier = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl, browserExecutablePath: null });
/**
 * A fetcher for the site that Cloudflare checks, and for a browser service that renders the
 * summary in the address it is asked for. The browser step sends its requests through the
 * adapter's fetcher.
 */
const checked = (render: (url: string) => string = url => summary(numberOf(url))) => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).startsWith('http://browser.test/')) return page(CHECK, { status: 403 });
    const { url: address } = JSON.parse(String(init!.body)) as { url: string };
    return Response.json({ tier: 3, statusCode: 200, url: address, html: render(address) });
  });
  return { fetcher, trawl: new TrawlClient('http://browser.test', fetcher) };
};

describe('Hi-Trans Express adapter', () => {
  it('reads a consignment’s scans with their depots’ clocks', async () => {
    const fetcher = direct();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HiTransTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ets 188 ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://online.hi-trans.com.au/Connotes/ShowConsignmentSummary.aspx?Number=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2020-10-26T08:37:59+11:00', expected_delivery: null,
      service_name: 'General', sender_name: 'ELECTASERV TRADING' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.map(event => [event.time, event.local_time, event.time_zone, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2020-10-26T08:37:59+11:00', '2020-10-26T08:37:59', 'Australia/Melbourne', '56', 'Delivered', 'Melbourne', 'delivered'],
      ['2020-10-26T08:30:16+11:00', '2020-10-26T08:30:16', 'Australia/Melbourne', '52', 'Driver Arrived for Delivery', 'Melbourne', 'out_for_delivery'],
      ['2020-10-26T06:12:08+11:00', '2020-10-26T06:12:08', 'Australia/Melbourne', '50', 'Loaded for Delivery', 'Melbourne', 'out_for_delivery'],
      ['2020-10-24T10:05:26+11:00', '2020-10-24T10:05:26', 'Australia/Melbourne', '47', 'Arrived at Delivery Depot', 'Melbourne', 'in_transit'],
      // Queensland keeps standard time all year.
      ['2020-10-21T19:48:56+10:00', '2020-10-21T19:48:56', 'Australia/Brisbane', '40', 'Loaded for Linehaul Transit', 'Brisbane', 'in_transit'],
    ]);
    expect(result.events!.every(event => event.time_zone_basis === 'place')).toBe(true);
    // Each instant falls within seconds of the time the reply says the scan was recorded, in UTC.
    const recorded = [...fixture(DELIVERED).matchAll(/"statusHistoryCreatedDateTimeUTC":"([^"]+)"/g)].map(match => Date.parse(`${match[1]}Z`)).reverse();
    result.events!.forEach((event, index) => expect(Math.abs(Date.parse(event.time!) - recorded[index]!)).toBeLessThan(5_000));
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hi-trans', step: 'direct', outcome: 'ok' }));
  });

  it('opens the summary in the browser service when Cloudflare checks the direct read', async () => {
    const { fetcher, trawl } = checked();
    const result = await carrier(fetcher, trawl).track({ number: ON_BOARD });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([hiTransSummaryUrl(ON_BOARD), 'http://browser.test/scrape']);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toMatchObject({ url: hiTransSummaryUrl(ON_BOARD), skipHttp: true, maxTier: 3 });
    // The freight is with the delivery truck or forwarder; the pickup scan came in after the linehaul's.
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Loaded for Delivery',
      last_update: '2018-04-06T11:57:48+10:00', service_name: 'Express', sender_name: 'METRIX GROUP' });
    expect(result.events!.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2018-04-06T11:57:48+10:00', 'Loaded for Delivery', 'Brisbane', 'out_for_delivery'],
      ['2018-04-06T08:54:32+10:00', 'Arrived at Delivery Depot', 'Brisbane', 'in_transit'],
      ['2018-04-05T07:59:34+10:00', 'Pickup Completed', 'Melbourne', 'accepted'],
      ['2018-04-04T20:25:11+10:00', 'Loaded for Linehaul Transit', 'Melbourne', 'in_transit'],
      ['2018-04-04T16:23:47+10:00', 'Driver Arrived for Pickup', 'Melbourne', 'registered'],
      ['2018-04-04T12:52:02+10:00', 'Allocated to Pickup Driver', 'Melbourne', 'registered'],
    ]);
  });

  it('reads the page’s notice as not found, and checks the number the page answers for', async () => {
    await expect(carrier(direct()).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    const service = checked();
    await expect(carrier(service.fetcher, service.trawl).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseHiTrans(fixture('not-found'), 'ZZZ0000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHiTrans(fixture(DELIVERED), ON_BOARD)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture(DELIVERED).replace(/"consignmentStatusHistory":\[.*?\],"pickupsDeliveries"/s, '"consignmentStatusHistory":[],"pickupsDeliveries"');
    expect(() => parseHiTrans(empty, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('keeps a scan’s wall clock alone when its depot’s state is not known', () => {
    const result = parseHiTrans(fixture(DELIVERED).replaceAll('"depot":"Melbourne"', '"depot":"Albury Wodonga"'), DELIVERED);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2020-10-26T08:37:59' });
    expect(result.events![0]).toEqual({ local_time: '2020-10-26T08:37:59', description: 'Delivered', provider_code: '56',
      location: 'Albury Wodonga', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events![4]).toMatchObject({ time: '2020-10-21T19:48:56+10:00', location: 'Brisbane' });
  });

  it('keeps a check, a rate limit and an outage apart from a missing consignment', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: DELIVERED });
    await expect(answer(page(CHECK, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page(CHECK))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(page('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
    // The browser service is asked once, and its own check is a challenge too.
    const service = checked(() => CHECK);
    await expect(carrier(service.fetcher, service.trawl).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'challenge' });
    expect(service.fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries once when the first read does not reach the site', async () => {
    const fetcher = direct();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads a changed page as a schema change', () => {
    expect(() => parseHiTrans('<html><body>Maintenance</body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHiTrans(fixture(DELIVERED).replace('window.consignment = {', 'window.consignment = {{'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHiTrans(fixture(DELIVERED).replace('"dateTime":"2020-10-26T08:37:59.693"', '"dateTime":"26/10/2020"'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHiTrans(fixture(DELIVERED).replace('"statusCode":56', '"statusCode":"56"'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('takes a consignment note of letters then digits', () => {
    expect(normalizeHiTransNumber('mtx-833')).toBe(ON_BOARD);
    expect(normalizeHiTransNumber('TEST1234')).toBe('TEST1234');
    for (const bad of ['833MTX', 'MTX', 'M1', 'ABCDEFGH12345678', 'MTX83A', '']) {
      expect(() => normalizeHiTransNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the codes statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'hi-trans', providerCode: code, description: wording }), code).toEqual({ kind: 'mapped', stage });
      expect(hiTransStage(code)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'hi-trans', providerCode: '99', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
