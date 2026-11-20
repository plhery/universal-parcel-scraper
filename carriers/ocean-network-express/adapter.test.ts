import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { containerCheckDigit, containerEvents, MAX_CONTAINER_LOOKUPS, oneQuery, oneResult, oneSearch } from './parser.js';
import { oneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: two bills of lading, their bookings, and a container. The synthetic numbers lie far beyond the ranges in use.
const BILL = 'ONEYSZPGT8264411';
const BOOKING = 'SZPGT8264411';
const MERGED = 'ONEYJKTG68267302';
const CONTAINER = 'ONEU3212864';
const SYNTHETIC_CONTAINER = 'ZZZU9999992';
const SYNTHETIC_BOOKING = 'ZZZZZ9999999';
const API = 'https://ecomm.one-line.com/api/v2/edh/containers/track-and-trace';
const events = (booking: string, container: string) => `${API}/cop-events?booking_no=${booking}&container_no=${container}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (body: string, status = 201) => new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const html = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const serve = (...replies: (() => Response)[]) => vi.fn<typeof fetch>(async () => replies.shift()!());
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const empty = '{"status":200,"code":1,"message":"Success"}';
const validated = (after: string, before = '') => JSON.stringify({ status: 200, code: 1, message: 'Success', data: { bkgBefore: before, bkgAfter: after } });
const delivered = () => [() => json(fixture('validate-szpgt8264411')), () => json(fixture('search-szpgt8264411')),
  () => json(fixture('events-szpgt8264411-oneu5068798'), 200)];
type Reply = { data: Record<string, unknown>[] } & Record<string, unknown>;
const reply = (name: string) => JSON.parse(fixture(name)) as Reply;

describe('Ocean Network Express HTTP adapter', () => {
  it("checks a bill's booking, searches it, then reads each container's events, as the page's script does, through the supplied transport", async () => {
    const fetcher = serve(...delivered());
    await expect(carrier(fetcher).track({ number: BILL })).resolves.toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [`${API}/validate-booking`, 'POST'], [`${API}/search`, 'POST'], [events(BOOKING, 'ONEU5068798'), 'GET']]);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === 'manual' && init.signal instanceof AbortSignal)).toBe(true);
    const body = (index: number) => JSON.parse(String(fetcher.mock.calls[index]![1]?.body)) as Record<string, unknown>;
    expect(body(0)).toEqual({ bookingNos: BOOKING, timestamp: expect.stringMatching(/^\d{13}$/) });
    expect(body(1)).toEqual({ page: 1, page_length: 100, filters: { search_text: BOOKING, search_type: 'BKG_NO' }, timestamp: body(0).timestamp });
    expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Origin: 'https://www.one-line.com', Referer: 'https://www.one-line.com/',
      'Content-Type': 'application/json', 'x-correlation-id': expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it("reads a container's events newest first at the instants ONE gives, on the clocks of their places", () => {
    const result = normalizeCarrierResult(oneResult(oneSearch(fixture('search-szpgt8264411'), oneQuery(BILL), BOOKING),
      [containerEvents(fixture('events-szpgt8264411-oneu5068798'))]));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Empty Container Returned from Customer', last_update: '2026-11-11T22:25:00-08:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events?.map(event => [event.time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2026-11-11T22:25:00-08:00', 'E138', 'Empty Container Returned from Customer', 'APM TERMINALS LA (MARINE), LOS ANGELES, CA, UNITED STATES', 'delivered'],
      ['2026-11-07T08:01:00-08:00', 'E106', 'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)', 'TRAPAC LOS ANGELES, LOS ANGELES, CA, UNITED STATES', 'out_for_delivery'],
      ['2026-11-04T20:39:00-08:00', 'E090', 'Unloaded from Vessel at Port of Discharging', 'TRAPAC LOS ANGELES, LOS ANGELES, CA, UNITED STATES', 'in_transit'],
      ['2026-11-03T08:03:00-08:00', 'E089', 'Vessel Arrival at Port of Discharge', 'TRAPAC LOS ANGELES, LOS ANGELES, CA, UNITED STATES', 'in_transit'],
      ['2026-10-16T13:47:00+08:00', 'E061', 'Vessel Departure from Port of Loading', 'YICT (YANTIAN INTL CONTAINER TERMINAL), YANTIAN, GUANGDONG, CHINA', 'in_transit'],
      ['2026-10-15T08:22:00+08:00', 'E058', 'Loaded on Vessel at Port of Loading', 'YICT (YANTIAN INTL CONTAINER TERMINAL), YANTIAN, GUANGDONG, CHINA', 'in_transit'],
      ['2026-10-03T23:32:00+08:00', 'E040', 'Gate In to Outbound Terminal', 'YICT (YANTIAN INTL CONTAINER TERMINAL), YANTIAN, GUANGDONG, CHINA', 'accepted'],
      ['2026-09-29T18:06:00+08:00', 'E012', 'Empty Container Release to Shipper', 'YICT (YANTIAN INTL CONTAINER TERMINAL), YANTIAN, GUANGDONG, CHINA', 'registered'],
    ]);
    expect(result.events?.every(event => !('local_time' in event))).toBe(true);
  });

  it('leaves out the moves ONE has not dated and reads a gate in at the port after a move inland as transit', () => {
    const { events: rail } = containerEvents(fixture('events-livg23578500-fdcu0533777'));
    expect(rail.map(event => event.provider_code)).toEqual(['E133', 'E138', 'E129', 'E118', 'E117', 'E110', 'E109', 'E090', 'E089', 'E061', 'E058', 'E034', 'E030', 'E027', 'E012']);
    expect(rail.find(event => event.provider_code === 'E027')).toMatchObject({ time: '2026-08-28T10:29:00+01:00', stage: 'accepted',
      location: 'BIRMINGHAM FREIGHTLINER RAIL TERMINAL, BIRMINGHAM, WEST MIDLANDS, UNITED KINGDOM' });
    expect(rail[0]).toMatchObject({ time: '2026-10-09T15:49:00-04:00', description: 'Full Container Delivery to Consignee', location: 'CAMBRIDGE, OH, UNITED STATES', stage: 'delivered' });
    const late = JSON.parse(fixture('events-livg23578500-fdcu0533777')) as Reply;
    late.data.push({ ...late.data.find(row => row.matrixId === 'E040') ?? late.data[2], matrixId: 'E040', eventName: 'Gate In to Outbound Terminal',
      eventLocalPortDate: '2026-09-03T10:00:00.000Z', eventDate: '2026-09-03T09:00:00.000Z' });
    expect(containerEvents(JSON.stringify(late)).events.find(event => event.provider_code === 'E040')).toMatchObject({ stage: 'in_transit' });
  });

  it("looks a container up by its number and its latest booking, and keeps the moves ONE estimates as planned steps", async () => {
    const fetcher = serve(() => json(fixture('search-oneu3212864')), () => json(fixture('events-ricgfw796300-oneu3212864'), 200));
    const result = normalizeCarrierResult(await carrier(fetcher).track({ number: CONTAINER }));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${API}/search`, events('RICGFW796300', CONTAINER)]);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ filters: { search_text: CONTAINER, search_type: 'CNTR_NO' } });
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Gate In to Outbound Terminal', last_update: '2026-11-17T08:51:00-06:00',
      expected_delivery: null });
    expect(result.events).toHaveLength(2);
    const port = 'BARBOURS CUT CONTAINER TERMINAL (PORT), HOUSTON, TX, UNITED STATES';
    const cartagena = 'TERMINAL DE CONTENEDORES DE CARTAGENA S.A., CARTAGENA, COLOMBIA';
    expect(result.planned_events).toEqual([
      { time: '2026-11-29T02:25:30-06:00', description: 'Loaded on Vessel at Port of Loading', location: port, stage: 'in_transit' },
      { time: '2026-11-29T07:00:00-06:00', description: 'Vessel Departure from Port of Loading', location: port, stage: 'in_transit' },
      { time: '2026-12-07T03:00:00-05:00', description: 'Vessel Arrival at Port of Discharge', location: cartagena, stage: 'in_transit' },
      { time: '2026-12-07T04:30:00-05:00', description: 'Unloaded from Vessel at Port of Discharging', location: cartagena, stage: 'in_transit' },
      { time: '2026-12-07T09:00:00-05:00', description: 'Gate Out from Inbound Terminal for Delivery to Consignee (or Port Shuttle)', location: cartagena, stage: 'out_for_delivery' },
      { time: '2026-12-07T15:00:00-05:00', description: 'Empty Container Returned from Customer', location: 'INTERMODAL - CARTAGENA, CARTAGENA, COLOMBIA', stage: 'delivered' },
    ]);
  });

  it("merges a booking's containers, keeping their shared moves once, and calls it delivered only once every container is", async () => {
    const containers = ['oneu1989027', 'oneu5204739', 'oneu6389405', 'oneu6636742'];
    const fetcher = serve(() => json(fixture('validate-jktg68267302')), () => json(fixture('search-jktg68267302')),
      ...containers.map(name => () => json(fixture(`events-jktg68267302-${name}`), 200)));
    const result = await carrier(fetcher).track({ number: MERGED });
    expect(fetcher.mock.calls.slice(2).map(([url]) => String(url))).toEqual(containers.map(name => events('JKTG68267302', name.toUpperCase())));
    // Each container has twelve moves; the vessels' two departures and two arrivals are shared.
    expect(result.events).toHaveLength(4 * 12 - 3 * 4);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-11-17T14:11:00-08:00' });
    const read = containers.map(name => containerEvents(fixture(`events-jktg68267302-${name}`)));
    const search = oneSearch(fixture('search-jktg68267302'), oneQuery(MERGED), 'JKTG68267302');
    const open = { ...read[1]!, events: read[1]!.events.slice(1) };
    expect(oneResult(search, [read[0]!, open, read[2]!, read[3]!])).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-11-17T14:11:00-08:00' });
  });

  it('cuts the history short past the containers it asks about, counting the others by the name of their latest event', () => {
    const search = reply('search-jktg68267302');
    const rows = Array.from({ length: MAX_CONTAINER_LOOKUPS + 1 }, (_, index) => ({ ...search.data[index % 4]!,
      containerNo: index < 4 ? search.data[index]!.containerNo : `ZZZU${String(index).padStart(6, '0')}${containerCheckDigit(`ZZZU${String(index).padStart(6, '0')}`)}` }));
    const many = (latest: string) => oneSearch(JSON.stringify({ ...search, total: rows.length,
      data: rows.map((row, index) => index === MAX_CONTAINER_LOOKUPS ? { ...row, latestEvent: { eventName: latest } } : row) }), oneQuery(MERGED), 'JKTG68267302');
    const read = Array.from({ length: MAX_CONTAINER_LOOKUPS }, () => containerEvents(fixture('events-jktg68267302-oneu1989027')));
    expect(oneResult(many('Inbound Rail Arrival'), read)).toMatchObject({ current_stage: 'in_transit', history_truncated: true });
    expect(oneResult(many('Empty Container Returned from Customer'), read)).toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(oneResult(many('Synthetic sample event'), read)).toMatchObject({ status: 'unknown' });
  });

  it('reads a booking ONE does not hold, or a container it does not, as not found, and one it lists without containers as no history', async () => {
    await expect(carrier(serve(() => json(validated('')))).track({ number: BILL })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(serve(() => json(empty))).track({ number: SYNTHETIC_CONTAINER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(serve(() => json(validated('', BOOKING)))).track({ number: BOOKING })).rejects.toMatchObject({ kind: 'indeterminate', message: expect.stringMatching(/earlier tracker/) });
    await expect(carrier(serve(() => json(validated(BOOKING)), () => json(empty))).track({ number: BILL }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('keeps another booking or container, a changed reply, a refusal, a bot check and a rate limit apart from a missing shipment', async () => {
    const ask = (...replies: (() => Response)[]) => carrier(serve(...replies)).track({ number: BILL });
    await expect(ask(() => json(validated(SYNTHETIC_BOOKING)), () => json(fixture('search-szpgt8264411')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(carrier(serve(() => json(fixture('search-oneu3212864')))).track({ number: SYNTHETIC_CONTAINER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json(validated('SAMPLE')))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => json('{"status":500,"code":0,"message":"Error"}'))).rejects.toMatchObject({ kind: 'schema' });
    const undated = reply('events-szpgt8264411-oneu5068798');
    undated.data = undated.data.map(row => ({ ...row, eventDate: 'yesterday' }));
    await expect(ask(...delivered().slice(0, 2), () => json(JSON.stringify(undated)))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(...delivered().slice(0, 2), () => json(empty))).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
    await expect(ask(() => html('<html><body>ONE</body></html>', 200))).rejects.toMatchObject({ kind: 'schema' });
    await expect(ask(() => html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(() => html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>', 200))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(ask(() => html('Too many requests', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(ask(() => html('', 404))).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(ask(() => html('', 503))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'));
    for (const next of delivered()) flaky.mockResolvedValueOnce(next());
    await expect(carrier(flaky).track({ number: BILL })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(4);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: BILL }, { budgetMs: 20.5 })).rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes a container with its check digit, a booking or an ONEY bill, and nothing else, without a request', async () => {
    expect([containerCheckDigit('ONEU321286'), containerCheckDigit('FDCU053377'), containerCheckDigit('ZZZU999999')]).toEqual([4, 7, 2]);
    expect(oneQuery(' oneu 321286-4 ')).toEqual({ kind: 'container', number: CONTAINER });
    expect(oneQuery(BILL)).toEqual({ kind: 'booking', number: BILL, booking: BOOKING });
    expect(oneQuery('sh6fvaf47900')).toEqual({ kind: 'booking', number: 'SH6FVAF47900', booking: 'SH6FVAF47900' });
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['ONEU3212865', 'ONEU321286', '123456789012', 'ONEY123456789012', 'SZPG8264411', 'ABCDEFGHIJKLM', 'SAMPLETRACKING', '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: BILL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is asked when the number is filed under Ocean Network Express', async () => {
    const fetcher = serve(...delivered());
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: BILL, carrier: 'ocean-network-express' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'ocean-network-express', source: 'ocean-network-express', result: { current_stage: 'delivered' } });
  });
});

describe('Ocean Network Express status vocabulary', () => {
  it('stages each event by its matrix id, whichever transshipment it counts', () => {
    for (const entry of statuses.entries) {
      expect(oneStage(entry.code), entry.wording).toBe(entry.stage);
      const answer = statusMapAnswer({ carrier: 'ocean-network-express', providerCode: entry.code, description: entry.wording });
      expect(answer.kind, entry.wording).toBe('mapped');
    }
    expect(statusMap.stage('E067-02', 'unloaded from vessel at transshipment port')).toBe('in_transit');
    expect(statusMap.stage(null, 'full container delivery to consignee')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'ocean-network-express', providerCode: 'E999', description: 'Sample note' })).toEqual({ kind: 'unknown' });
  });
});
