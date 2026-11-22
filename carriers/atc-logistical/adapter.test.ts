import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ATC_LOOKUP, atcLookupUrl, atcPageUrl } from './adapter.js';
import { normalizeAtcNumber, parseAtcPage } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's page, with its people, phones, address and invoice replaced; the tests derive invented consignments from it.
const SAMPLE = 'R432490';
const OTHER = 'R900001';
const PAGE_URL = 'https://www.atcsure.com/tracking.php?gc=1R43249003151347';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SAMPLE_PAGE = fixture(`tracking-${SAMPLE}.html`);
const LOOKUP = JSON.parse(fixture(`lookup-${SAMPLE}.json`)) as unknown;
const NOT_FOUND = JSON.parse(fixture('lookup-not-found.json')) as unknown;

type Reply = { Status: string; Message: string; Result: { general_details: Record<string, unknown>[]; crossing_details: Record<string, unknown>[] } };
const LITERAL = /^var responsetext = '(.*)';$/m;
const sampleReply = () => JSON.parse(LITERAL.exec(SAMPLE_PAGE)![1]!) as Reply;
/** The sample's page holding another reply, written as the page writes it. */
const pageOf = (reply: unknown) => SAMPLE_PAGE.replace(LITERAL, () => `var responsetext = '${JSON.stringify(reply).replaceAll('/', '\\/')}';`);
/** The sample's consignment under another number, with its details and manifests changed. */
const consignment = (general: Record<string, unknown> = {}, manifests?: (all: Record<string, unknown>[]) => Record<string, unknown>[]) => {
  const reply = sampleReply();
  reply.Result.general_details[0] = { ...reply.Result.general_details[0], GC_No: OTHER, ...general };
  if (manifests) reply.Result.crossing_details = manifests(reply.Result.crossing_details);
  return pageOf(reply);
};

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** A tracker that answers the lookup and the page with these replies. */
const tracker = (lookup: () => Response, page: () => Response = () => html(SAMPLE_PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(ATC_LOOKUP) ? lookup() : page()));

describe('ATC numbers', () => {
  it('takes a consignment note number in letters and digits', () => {
    expect(normalizeAtcNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeAtcNumber('98765432')).toBe('98765432');
    for (const other of ['', 'R12', 'ABCDEFG', 'R4324!0', 'R'.repeat(20) + '1']) {
      expect(() => normalizeAtcNumber(other), other).toThrow('LR number on the ATC consignment note');
    }
  });
});

describe('ATC tracking adapter', () => {
  it('asks the lookup for the number’s page and reads that page, as the Track Shipment form does', async () => {
    const fetcher = tracker(() => json(LOOKUP));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[lookup, init], [page]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(lookup).toBe('https://atcsure.com/proxy.php?action=trackntrace_website&jsonreq=%7B%22GC_No%22%3A%22R432490%22%7D');
    expect(lookup).toBe(atcLookupUrl(SAMPLE));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(page).toBe(PAGE_URL);
    expect(carrier(fetcher)).toMatchObject({ id: 'atc-logistical', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the lookup’s invalid number answer as not found, without opening a page', async () => {
    const fetcher = tracker(() => json(NOT_FOUND));
    await expect(carrier(fetcher).track({ number: '98765432' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, error pages, moved pages and other consignments apart from a missing one', async () => {
    const answer = async (lookup: () => Response, page?: () => Response) => carrier(tracker(lookup, page))
      .track({ number: SAMPLE }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Forbidden</title>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<b>Fatal error</b>: Uncaught TypeError'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://atcsure.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<title>404 Not Found</title>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({ Status: '0', Message: 'Error', Result: [] }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ ...LOOKUP as object, Result: [{ Url: 'https://example.com/tracking.php?gc=1' }] }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(LOOKUP), () => html('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json(LOOKUP), () => html('<title>ATCsure - Tracking</title>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(LOOKUP), () => html(pageOf({ Status: '0', Message: 'No LRs for the trip memo', Result: [] }))))
      .toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json(LOOKUP), () => html(consignment()))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('ATC replies', () => {
  it('names the page of a known number, and nothing for an invalid one', () => {
    expect(atcPageUrl(LOOKUP)).toBe(PAGE_URL);
    expect(() => atcPageUrl(NOT_FOUND)).toThrow('no consignment under this LR number');
  });

  it('reads the public sample: its booking and each manifest’s dispatch and unloading, on the tracker’s dates', () => {
    expect(parseAtcPage(SAMPLE_PAGE, SAMPLE)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: 'DISPATCHED',
      last_status_text: 'In transit (LUCKNOW To SHAMBHAVI ROAD LINES)', last_update: null, last_update_local: '2023-07-07',
      expected_delivery: null,
      events: [
        { local_time: '2023-07-07', description: 'Dispatched to SHAMBHAVI ROAD LINES', provider_code: 'OUTWARD', location: 'LUCKNOW', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-07-07', description: 'Unloaded', provider_code: 'AUS', location: 'LUCKNOW', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-07-05', description: 'Dispatched to LUCKNOW', provider_code: 'OUTWARD', location: 'JAMALPUR HUB', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-07-05', description: 'Unloaded', provider_code: 'AUS', location: 'JAMALPUR HUB', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-07-04', description: 'Dispatched to JAMALPUR HUB', provider_code: 'OUTWARD', location: 'NARAINA', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2023-07-03', description: 'Consignment booked', provider_code: 'BOOKED', location: 'NARAINA', stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('never gives the consignment’s people, phones, address, invoice or vehicles', () => {
    const text = JSON.stringify(parseAtcPage(SAMPLE_PAGE, SAMPLE));
    for (const hidden of ['SAMPLE', '9000000', 'INV-0001', 'UP32KN6405', 'AKBAR PUR', 'BO0434']) expect(text).not.toContain(hidden);
  });

  it('reads a delivered consignment’s milestones at its delivery branch, with their clocks', () => {
    const page = consignment({
      CurrentStatus: 'DELIVERED', InwardDate: '2023-07-08 00:00:00.000', PDSDate: '2023-07-09 09:15:00.000', DlyDate: '2023-07-09 16:40:00.000',
    }, (all) => all.map((manifest, index) => (index === 2
      ? { ...manifest, 'AUS/DDC Date': '08 Jul 2023', 'Unloaded/Deliverd At': 'SHAMBHAVI ROAD LINES' } : manifest)));
    const result = parseAtcPage(page, OTHER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', provider_code: 'DELIVERED',
      last_status_text: 'Consignment delivered', last_update_local: '2023-07-09T16:40:00' });
    // The last leg's unloading is the delivery branch's own inward milestone, so it is given once.
    expect(result.events?.slice(0, 4)).toEqual([
      { local_time: '2023-07-09T16:40:00', description: 'Consignment delivered', provider_code: 'DELIVERED', location: 'SHAMBHAVI ROAD LINES', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2023-07-09T09:15:00', description: 'Out for delivery', provider_code: 'LEFT FOR DELIVERY', location: 'SHAMBHAVI ROAD LINES', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2023-07-08', description: 'Reached at delivery branch', provider_code: 'AT DELIVERY BRANCH', location: 'SHAMBHAVI ROAD LINES', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2023-07-07', description: 'Dispatched to SHAMBHAVI ROAD LINES', provider_code: 'OUTWARD', location: 'LUCKNOW', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
  });

  it('gives a consignment without manifests its own dispatch, and a booked one its booking alone', () => {
    expect(parseAtcPage(consignment({}, () => []), OTHER).events?.map((event) => [event.local_time, event.provider_code]))
      .toEqual([['2023-07-07', 'DISPATCHED'], ['2023-07-03', 'BOOKED']]);
    expect(parseAtcPage(consignment({ CurrentStatus: 'BOOKED', DispachDate: null }, () => []), OTHER))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Consignment booked', events: [{ provider_code: 'BOOKED' }] });
  });

  it('keeps a status it does not know, and refuses invalid dates and manifests', () => {
    expect(parseAtcPage(consignment({ CurrentStatus: 'HOLD' }), OTHER)).toMatchObject({ status: 'unknown', provider_code: 'HOLD', last_status_text: 'HOLD' });
    expect(() => parseAtcPage(consignment({ GC_Date: '2023-13-03 00:00:00.000' }), OTHER)).toThrow('invalid date');
    expect(() => parseAtcPage(consignment({}, (all) => [{ ...all[0], 'Memo Date': '31 Feb 2023' }]), OTHER)).toThrow('invalid manifest date');
    expect(() => parseAtcPage(consignment({}, () => ['x'] as never), OTHER)).toThrow('invalid manifests');
    expect(() => parseAtcPage(consignment({ CurrentStatus: '' }), OTHER)).toThrow('without a status');
    expect(() => parseAtcPage(SAMPLE_PAGE.replace(LITERAL, "var responsetext = '<b>Warning</b>';"), SAMPLE)).toThrow('not JSON');
  });
});

describe('ATC statuses', () => {
  it('maps each status and manifest caption the page gives', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'atc-logistical', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});
