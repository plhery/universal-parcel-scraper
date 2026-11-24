import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BOOTHS_PAGE_KEY, BOOTHS_RESULTS_PAGE, BOOTHS_SEARCH, boothsConsignmentUrl } from './adapter.js';
import { boothsHit, normalizeBoothsNumber, parseBooths } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's replies, with the job's addresses blanked; the tests derive invented consignments from them.
const SAMPLE = 'BCPTEST8';
const OTHER = 'ZZ90000001';

type Reply = { data: Record<string, unknown> & { events: Record<string, unknown>[] } };
const fixture = <T = Reply>(name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const SEARCH = fixture<{ data: Record<string, unknown>[] }>(`search-${SAMPLE}`);
const CONSIGNMENT = fixture(`consignment-${SAMPLE}`);
const BOOKED = CONSIGNMENT.data.events[0]!;
const event = (changes: Record<string, unknown>) => ({ ...BOOKED, ...changes });
/** The sample's consignment under another number, with its status and events replaced when given. */
const consignment = (changes: { reference?: string; status?: string | null; events?: Record<string, unknown>[] } = {}) => ({
  ...CONSIGNMENT, data: { ...CONSIGNMENT.data, reference: changes.reference ?? OTHER,
    status: changes.status === undefined ? CONSIGNMENT.data.status : changes.status, events: changes.events ?? CONSIGNMENT.data.events },
});
const search = (...hits: Record<string, unknown>[]) => ({ ...SEARCH, data: hits.map((hit) => ({ ...SEARCH.data[0], ...hit })) });

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const keyOf = (init: RequestInit | undefined) => (init?.headers as Record<string, string>)['Api-Key'];

describe('Booth\'s numbers', () => {
  it('takes a consignment number in letters and digits', () => {
    expect(normalizeBoothsNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeBoothsNumber('100 067 364')).toBe('100067364');
    for (const other of ['', 'ABCDEFG', '123', 'BCP/TEST8', 'X'.repeat(30) + '1']) {
      expect(() => normalizeBoothsNumber(other), other).toThrow('Booth\'s consignment number');
    }
  });
});

describe('Booth\'s tracking adapter', () => {
  it('searches the number, then opens the consignment the search lists, with the results page\'s key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => json(String(url).startsWith(BOOTHS_SEARCH) ? SEARCH : CONSIGNMENT));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'exception', last_status_text: 'Cancelled' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${BOOTHS_SEARCH}?reference=${SAMPLE}`, boothsConsignmentUrl(246746, 38285)]);
    expect(boothsConsignmentUrl(246746, null)).toBe('https://portal.booths.co.nz/OnEvent.BLL.Public.API/ConsignmentTrack/246746?containerId=');
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ signal: expect.any(AbortSignal) });
      expect(keyOf(init)).toBe(BOOTHS_PAGE_KEY);
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'booths-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads an empty search as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('search-not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads the key the results page gives when the service refuses its own', async () => {
    const fresh = '00000000-1111-2222-3333-444444444444';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url) === BOOTHS_RESULTS_PAGE) return new Response(`<script>var trackTraceAjax = {"api_key":"${fresh}"};</script>`, { headers: { 'Content-Type': 'text/html' } });
      if (keyOf(init) !== fresh) return new Response('You do not have a valid API key.', { status: 401 });
      return json(String(url).startsWith(BOOTHS_SEARCH) ? SEARCH : CONSIGNMENT);
    });
    const tracker = carrier(fetcher);
    await expect(tracker.track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'exception' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    // The key read stays for the next lookup.
    await tracker.track({ number: SAMPLE });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('keeps refusals, block pages and broken replies apart from a missing consignment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async (url) => (
      String(url) === BOOTHS_RESULTS_PAGE ? new Response(`{"api_key":"${BOOTHS_PAGE_KEY}"}`) : response())))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => new Response('You do not have a valid API key.', { status: 401 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<title>Access Denied</title>', { status: 403, headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ data: null, success: false, failed: true, message: 'Something went wrong' }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('Server Error', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
  });
});

describe('Booth\'s replies', () => {
  it('reads the public sample: a container job booked, then cancelled, on New Zealand\'s clock', () => {
    expect(boothsHit(SEARCH, SAMPLE)).toEqual({ id: 246746, containerId: 38285 });
    const result = parseBooths(CONSIGNMENT, SAMPLE);
    expect(result).toEqual({
      status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Cancelled', last_update: '2024-10-30T15:33:36+13:00', expected_delivery: null,
      events: [
        { time: '2024-10-30T15:33:36+13:00', description: 'Cancelled', provider_code: 'Cancelled', stage: 'exception', stage_source: 'carrier_map' },
        { time: '2024-10-15T14:35:35+13:00', description: 'Booked', provider_code: 'Booked', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('answers only a consignment listed under the number itself', () => {
    expect(() => boothsHit(fixture('search-not-found'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // A customer's order reference lists its consignments under their own numbers.
    expect(() => boothsHit(search({ reference: 'ZZ90000002' }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => boothsHit(search({ reference: OTHER, id: 1 }, { reference: OTHER, id: 2 }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(boothsHit(search({ reference: 'zz9-000-0001', containerID: null }), OTHER)).toEqual({ id: 246746, containerId: null });
    expect(() => parseBooths(consignment({ reference: 'ZZ90000002' }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('shows the milestones as the tracker does: each code once per place, newest first, with its place', () => {
    const scan = (code: string, name: string | null, date: string, utc: string, location?: string, milestone = true) => event({
      eventCode: code, eventName: code, milestoneName: name, eventDate: date, eventDateUtc: utc, milestone,
      locations: location ? [{ locationName: location }] : [] });
    const result = parseBooths(consignment({ status: 'Delivered', events: [
      scan('Booked', 'Booked', '2025-06-02T09:12:00', '2025-06-01T21:12:00'),
      scan('PickedUp', 'Picked Up', '2025-06-02T15:40:00', '2025-06-02T03:40:00', 'Depot A'),
      scan('Arrived', 'At Location', '2025-06-03T05:10:00', '2025-06-02T17:10:00', 'Booths Depot B'),
      scan('Arrived', 'At Location', '2025-06-03T05:01:00', '2025-06-02T17:01:00', 'Booths Depot B'),
      scan('Sorted', null, '2025-06-03T05:20:00', '2025-06-02T17:20:00', 'Booths Depot B', false),
      scan('OutForDelivery', 'Out for Delivery', '2025-06-03T07:30:00', '2025-06-02T19:30:00', 'Booths Depot B'),
      scan('Delivered', 'Delivered', '2025-06-03T10:02:00', '2025-06-02T22:02:00', 'Receiver C'),
    ] }), OTHER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2025-06-03T10:02:00+12:00', delivered_at: '2025-06-03T10:02:00+12:00' });
    expect(result.events!.map((scan) => [scan.time, scan.description, scan.location, scan.stage])).toEqual([
      ['2025-06-03T10:02:00+12:00', 'Delivered', 'Receiver C', 'delivered'],
      ['2025-06-03T07:30:00+12:00', 'Out for Delivery', 'Booths Depot B', 'out_for_delivery'],
      ['2025-06-03T05:10:00+12:00', 'At Location', 'Booths Depot B', 'in_transit'],
      ['2025-06-02T15:40:00+12:00', 'Picked Up', 'Depot A', 'accepted'],
      ['2025-06-02T09:12:00+12:00', 'Booked', undefined, 'registered'],
    ]);
  });

  it('keeps a wall clock its UTC time does not state, and stages by the events when the status is unknown', () => {
    const result = parseBooths(consignment({ status: 'Pack', events: [
      event({ eventCode: 'PickedUp', eventName: 'Picked Up', milestoneName: null, eventDate: '2025-06-02T15:40:00', eventDateUtc: '2025-06-02T03:47:12' }),
      event({ eventCode: 'Moved', eventName: 'In Transit', milestoneName: null, eventDate: '2025-06-02T18:00:00', eventDateUtc: null }),
    ] }), OTHER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Pack', last_update: null, last_update_local: '2025-06-02T18:00:00' });
    expect(result.events).toEqual([
      { local_time: '2025-06-02T18:00:00', description: 'In Transit', provider_code: 'Moved', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2025-06-02T15:40:00', description: 'Picked Up', provider_code: 'PickedUp', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(parseBooths(consignment({ status: 'Draft', events: [] }), OTHER)).toMatchObject({ status: 'unknown', summary_only: true, events: [] });
  });

  it('refuses a changed reply', () => {
    for (const reply of [null, {}, { data: [], success: 'yes' }, { data: {}, success: true }, consignment({ status: null, events: [] }),
      { ...CONSIGNMENT, data: { ...CONSIGNMENT.data, reference: OTHER, events: {} } }, consignment({ events: [event({ eventDate: '30/10/2024 15:33' })] }),
      consignment({ events: [event({ eventCode: '' })] }), consignment({ events: [event({ milestone: 'yes' })] }),
      consignment({ events: [event({ eventDateUtc: 'soon' })] }), consignment({ events: [event({ locations: 'Depot' })] })]) {
      expect(() => parseBooths(reply, OTHER), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const reply of [{ data: {}, success: true }, { data: [{ id: 'x', reference: OTHER }], success: true }, { data: [{ id: 1, containerID: -1, reference: OTHER }], success: true }]) {
      expect(() => boothsHit(reply, OTHER), JSON.stringify(reply)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Booth\'s statuses', () => {
  it('maps each code and wording it records', () => {
    for (const entry of statuses.entries) {
      const code = ('code' in entry ? entry.code : undefined) ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'booths-logistics', providerCode: code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('Unknown', 'anything')).toBeUndefined();
  });
});
