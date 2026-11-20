import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TEJ_TRACKING_URL, TejTracker } from './adapter.js';
import { normalizeTejNumber, parseTej, tejClock, tejWording } from './parser.js';
import { statusMap, tejStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = '10000017';
const IN_TRANSIT = '20000024';
const UNKNOWN = '90000031';

type Row = Record<string, unknown>;
type Shipment = Row & { transitHistory: Row[] };

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const shipmentOf = (name: string): Shipment =>
  JSON.parse((fixture(name) as [{ PayLoad: string }])[0].PayLoad).payload.individualTrackingList[0];
/** A reply as the service sends it: the tracking list as a JSON document in the first row's `PayLoad`. */
const reply = (shipment: unknown) => [{ PayLoad: JSON.stringify({ payload: { individualTrackingList: [shipment] } }) }];
const edited = (name: string, edit: (shipment: Shipment) => void) => {
  const shipment = shipmentOf(name);
  edit(shipment);
  return reply(shipment);
};
/** The in-transit consignment with these scans, as `[clock, wording]`, oldest first. */
const scans = (...rows: (readonly [string, string])[]) => edited('in-transit', (shipment) => {
  shipment.transitHistory = rows.map(([dateAndTime, Activety]) => ({ dateAndTime, transitLocation: 'SAMPLE TOWN', Activety }));
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html' } });
const site = (lookup: (url: string) => Response) => vi.fn<typeof fetch>().mockImplementation(async (url) => lookup(String(url)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookupUrl = (number: string) => `${TEJ_TRACKING_URL}?tracking=${number}`;

describe('Tej Couriers HTTP adapter', () => {

  it('keeps the native pending history, stable ties and wall clocks while dropping the empty activity', () => {
    const result = parseTej(fixture('native-pending'), '30000031');
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'RunSheet',
      last_update_local: '2026-01-13T21:33:00', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events!.map(event => event.description)).toEqual(['RunSheet', 'Pending', 'RunSheet', 'InScan', 'OutScan', 'Booking Inward Done']);
    expect(result.events!.at(-1)).toMatchObject({ stage: 'accepted' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(tejStage('Pending')).toBeNull();
    expect(statusMapAnswer({ carrier: 'tej-couriers', providerCode: null, description: 'Pending' }).kind).toBe('intentional_gap');
    expect(() => parseTej(scans(['12-02-2026 11:00:00', '']), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('rejects multiple identities and error envelopes rather than using the first item', () => {
    const first = shipmentOf('in-transit');
    const other = { ...first, cnote: '30000031' };
    expect(() => parseTej([{ PayLoad: JSON.stringify({ payload: { individualTrackingList: [first, other] } }) }], IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTej([...reply(first), ...reply(other)], IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTej([{ statusCode: 401, errorMessage: 'SAMPLE REFUSAL' }], IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('looks the whole number up as the tracking page does, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new TejTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 1000 0017 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe('https://www.tejcouriers.com/api/tracking/php/tracking.php?tracking=10000017');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', Referer: 'https://www.tejcouriers.com/shipment-tracking.php', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'tej-couriers', step: 'direct', outcome: 'ok' }));
  });

  it('keeps wall clocks without an offset and stages each scan by its wording, newest first', () => {
    const result = parseTej(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivery Done', last_update: null, last_update_local: '2026-01-06T14:20:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage, event.description])).toEqual([
      ['2026-01-06T14:20:00', 'SAMPLE TOWN', 'delivered', 'Delivery Done'],
      ['2026-01-06T09:30:00', 'SAMPLE TOWN', 'out_for_delivery', 'RunSheet Prepared'],
      ['2026-01-06T07:05:00', 'SAMPLE TOWN', 'accepted', 'Received At SAMPLE TOWN'],
      ['2026-01-05T18:40:00', 'SAMPLE HUB', 'in_transit', 'Dispatched To SAMPLE TOWN'],
      ['2026-01-05T10:15:00', 'SAMPLE ORIGIN', 'registered', 'Booked'],
    ]);
    expect(result.events!.every((event) => !event.time && !event.provider_code)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('history_truncated');
  });

  it('reads several scans before a delivery run as in transit, as the page sums them up, with the expected delivery day', () => {
    expect(parseTej(fixture('in-transit'), IN_TRANSIT)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      current_stage_source: 'carrier_map', last_status_text: 'Received At SAMPLE TOWN', last_update_local: '2026-02-12T06:10:00',
      expected_delivery: '2026-02-13' });
    expect(parseTej(scans(['11-02-2026 11:00:00', 'Booked']), IN_TRANSIT)).toMatchObject({ current_stage: 'registered', current_stage_source: 'carrier_map' });
    expect(parseTej(scans(['11-02-2026 11:00:00', 'Booked'], ['11-02-2026 19:30:00', 'Inscan']), IN_TRANSIT))
      .toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Inscan' });
    expect(parseTej(scans(['11-02-2026 11:00:00', 'Shipment Picked Up']), IN_TRANSIT)).toMatchObject({ current_stage: 'accepted' });
    const out = parseTej(scans(['11-02-2026 11:00:00', 'Booked'], ['12-02-2026 09:00:00', 'RunSheet Prepared By SAMPLE NAME'],
      ['12-02-2026 17:00:00', 'Undelivered - Consignee not available']), IN_TRANSIT);
    expect(out).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Undelivered - Consignee not available', expected_delivery: '2026-02-13' });
    const unreadable = parseTej(edited('in-transit', (shipment) => { shipment.DlvDate = '13/02/2026'; }), IN_TRANSIT);
    expect(unreadable.expected_delivery).toBeNull();
  });

  it('keeps no sender, receiver, courier, phone number, postcode, weight or proof-of-delivery link', () => {
    for (const [name, number] of [['delivered', DELIVERED], ['in-transit', IN_TRANSIT]] as const) {
      const text = JSON.stringify(parseTej(fixture(name), number));
      expect(text, name).not.toMatch(/SENDER|RECEIVER|COURIER|Self|Mob|9000|000000|0\.500|example\.invalid|pod\//);
    }
    expect(tejWording('Delivery Done - Received By SAMPLE NAME (Self) Mob: 9000000000', 'delivered')).toBe('Delivery Done');
    expect(tejWording('RunSheet Prepared By SAMPLE NAME', 'out_for_delivery')).toBe('RunSheet Prepared');
    expect(tejWording('Undelivered - Consignee not available, Contact: +91 90000-00000', 'failed_attempt')).toBe('Undelivered - Consignee not available');
    expect(tejWording('Delivered To SAMPLE NAME', 'delivered')).toBe('Delivered');
    expect(tejWording('Shipment Picked Up, Boy Name: SAMPLE NAME', 'accepted')).toBe('Shipment Picked Up');
    expect(tejWording('Dispatched To SAMPLE TOWN', 'in_transit')).toBe('Dispatched To SAMPLE TOWN');
  });

  it('reads a return delivered to the sender as returned, and one under way as an exception', () => {
    expect(tejStage('RTO Delivery Done')).toEqual({ stage: 'returned', source: 'carrier_map' });
    expect(tejStage('RTO Dispatched To SAMPLE HUB')).toEqual({ stage: 'exception', source: 'carrier_map' });
    const returned = parseTej(edited('delivered', (shipment) => {
      shipment.transitHistory.at(-1)!.Activety = 'RTO Delivery Done - Received By SAMPLE NAME';
    }), DELIVERED);
    expect(returned).toMatchObject({ current_stage: 'returned', last_status_text: 'RTO Delivery Done', expected_delivery: null });
  });

  it('reads the clocks an Indian system writes, day first, and keeps a day without a time', () => {
    for (const [clock, local] of [
      ['06-01-2026 14:20:00', '2026-01-06T14:20:00'],
      ['6/1/2026 2:20 PM', '2026-01-06T14:20:00'],
      ['06-Jan-2026 12:05:09 AM', '2026-01-06T00:05:09'],
      ['06 JAN 2026, 12:05 pm', '2026-01-06T12:05:00'],
      ['2026-01-06T14:20:00.123', '2026-01-06T14:20:00'],
      ['2026-01-06 14:20', '2026-01-06T14:20:00'],
      ['06.01.2026', '2026-01-06'],
    ] as const) expect(tejClock(clock), clock).toBe(local);
    for (const clock of ['31-09-2026 10:00:00', '06-01-2026 24:00:00', '06-01-2026 13:00 PM', '01/13/2026 10:00:00', '06-Foo-2026 10:00',
      '2026-01-06T14:20:00+05:30', '06-01-1970 10:00:00', 'yesterday', '']) {
      expect(() => tejClock(clock), clock).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown wording without a stage, orders scans on one clock as listed and caps a long history', () => {
    const unknown = parseTej(edited('delivered', (shipment) => { shipment.transitHistory.at(-1)!.Activety = 'SAMPLE NOTE'; }), DELIVERED);
    expect(unknown.events![0]).toMatchObject({ description: 'SAMPLE NOTE' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    expect(unknown).toMatchObject({ current_stage: 'out_for_delivery', last_status_text: 'SAMPLE NOTE' });
    expect(tejStage('SAMPLE NOTE')).toBeNull();
    const sameClock = parseTej(edited('delivered', (shipment) => {
      shipment.transitHistory.at(-1)!.dateAndTime = shipment.transitHistory.at(-2)!.dateAndTime;
    }), DELIVERED);
    expect(sameClock.events!.slice(0, 2).map((event) => event.description)).toEqual(['Delivery Done', 'RunSheet Prepared']);
    const reversed = parseTej(edited('delivered', (shipment) => { shipment.transitHistory.reverse(); }), DELIVERED);
    expect(reversed.events!.map((event) => event.description)).toEqual(parseTej(fixture('delivered'), DELIVERED).events!.map((event) => event.description));
    const repeated = parseTej(edited('in-transit', (shipment) => { shipment.transitHistory.push({ ...shipment.transitHistory[1]! }); }), IN_TRANSIT);
    expect(repeated.events).toHaveLength(3);
    const long = parseTej(scans(...Array.from({ length: 120 }, (_, index) =>
      [`12-02-2026 ${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00`, 'Inscan'] as const)), IN_TRANSIT);
    expect(long).toMatchObject({ history_truncated: true, last_update_local: '2026-02-12T01:59:00' });
    expect(long.events).toHaveLength(100);
  });

  it('distinguishes explicit missing replies from refused or unfinished lookups', () => {
    expect(() => parseTej(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTej(fixture('unknown'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTej([], UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTej({ error: 'SAMPLE' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTej(edited('in-transit', (shipment) => { shipment.transitHistory = []; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    expect(() => parseTej([{ PayLoad: JSON.stringify({ payload: { individualTrackingList: [] } }) }], IN_TRANSIT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('counts a consignment only when it names the whole number asked', () => {
    expect(() => parseTej(fixture('in-transit'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Tej Couriers answered for another consignment' }));
    for (const cnote of ['2000002', '200000245', '20000025', '020000024', '20000024 x', '']) {
      expect(() => parseTej(edited('in-transit', (shipment) => { shipment.cnote = cnote; }), IN_TRANSIT), cnote)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(parseTej(edited('in-transit', (shipment) => { shipment.cnote = 20000024; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    expect(parseTej(edited('in-transit', (shipment) => { shipment.cnote = ' 20000024 '; }), IN_TRANSIT)).toMatchObject({ current_stage: 'in_transit' });
    for (const cnote of [null, undefined, -20000024, 20000024.5, { value: IN_TRANSIT }]) {
      expect(() => parseTej(edited('in-transit', (shipment) => { shipment.cnote = cnote; }), IN_TRANSIT), String(cnote))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('rejects a changed reply', () => {
    for (const changed of [
      null, '', 'Consignment Not Found', 7, {}, { notfound: 'yes' }, { message: 'Consignment not found' }, ['row'], [{}],
      [{ Cnote_no: 0, Status: 'Success', Date: '', Time: 0 }], [{ PayLoad: 7 }], [{ PayLoad: '{"payload":' }], [{ PayLoad: '{}' }],
      [{ PayLoad: JSON.stringify({ payload: { individualTrackingList: {} } }) }], reply('shipment'),
      edited('in-transit', (shipment) => { shipment.transitHistory = 'none' as never; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0] = 'scan' as never; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.Activety = 'Mob: 9000000000'; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.Activety = { text: 'SAMPLE' }; }),
      edited('in-transit', (shipment) => { delete shipment.transitHistory[0]!.Activety; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.transitLocation = 7; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.dateAndTime = '31-09-2026 10:00:00'; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.dateAndTime = null; }),
      edited('in-transit', (shipment) => { shipment.transitHistory[0]!.dateAndTime = 1770800000000; }),
      edited('in-transit', (shipment) => { shipment.transitHistory = Array.from({ length: 501 }, () => shipment.transitHistory[0]!); }),
    ]) {
      expect(() => parseTej(changed, IN_TRANSIT), JSON.stringify(changed)?.slice(0, 160)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a firewall refusal, a moved route, a block page and a broken reply apart', async () => {
    const lookup = (response: Response) => carrier(site(() => response)).track({ number: UNKNOWN });
    await expect(lookup(json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(json(fixture('unknown')))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The site's firewall answers some clients 406 whatever the number: a refusal, not an unknown number.
    await expect(lookup(html('<html><head><title>406 Not Acceptable</title></head><body>Mod_Security</body></html>', { status: 406 })))
      .rejects.toMatchObject({ kind: 'challenge', status: 406 });
    await expect(lookup(json(fixture('not-found'), { status: 406 }))).rejects.toMatchObject({ kind: 'challenge', status: 406 });
    await expect(lookup(html('<html><title>Not Found</title></html>', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(new Response('', { status: 301, headers: { Location: 'https://www.tejcouriers.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(html('<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Not Acceptable!</title><body>An appropriate representation was not found.</body></html>')))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(html('<html><title>Tej Couriers</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(new Response('[{"PayLoad":', { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s during retrieval and recognition', async (status, kind) => {
      const fetcher = site(() => new Response('', { status, headers: status === 429 ? { 'Retry-After': '30' } : {} }));
      await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ kind, status });
      await expect(carrier(fetcher).recognize!(IN_TRANSIT)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (status === 429) await expect(carrier(fetcher).track({ number: IN_TRANSIT })).rejects.toMatchObject({ retryAfterMs: 30_000 });
    });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([lookupUrl(DELIVERED), lookupUrl(DELIVERED)]);
  });

  it('recognizes a known consignment without an instant, an unknown one, and asks nothing for a number Tej does not issue', async () => {
    const fetcher = site((url) => json(url === lookupUrl(DELIVERED) ? fixture('delivered') : fixture('not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, lastActivityAt: null,
      lastActivityLocal: '2026-01-06T14:20:00' });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toMatchObject({ known: false });
    await expect(carrier(fetcher).recognize!('100000170')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers Tej does not issue and pre-aborted lookups without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '1000001', '100000170', 'A1000001', 'TEJ10000017', '10000017,20000024', '1000001%', '1'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeTejNumber('1000-0017')).toBe(DELIVERED);
  });

  it('ends a hanging lookup inside the caller’s budget', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('routes a number filed under Tej Couriers to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered')));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: '1000 0017', carrier: 'tej-couriers' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'tej-couriers', source: 'tej-couriers', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url) === lookupUrl(DELIVERED))).toBe(true);
  });

  it('leaves consignment numbers to the caller: no rule claims eight digits for Tej', () => {
    for (const number of [DELIVERED, IN_TRANSIT, UNKNOWN]) expect(detectCarrierMatch(number).carrier, number).not.toBe('tej-couriers');
  });
});

describe('Tej Couriers status vocabulary', () => {
  it('records the scan wordings the map knows with the stage it gives, and the page’s summary badges', () => {
    const entries = statuses.entries as { wording: string; stage: string; confirmedBy: string }[];
    const scanned = entries.filter((entry) => entry.confirmedBy === 'bundle');
    expect(scanned.map((entry) => entry.wording)).toEqual(['Delivery Done', 'RunSheet']);
    for (const entry of scanned) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      expect(tejStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    for (const entry of entries.filter(candidate => candidate.confirmedBy === 'live')) {
      expect(tejStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // Each badge is what the page shows for a history the adapter stages the same way.
    const badges: Record<string, ReturnType<typeof scans>> = {
      Booked: scans(['11-02-2026 11:00:00', 'Booked']),
      'In Transit': scans(['11-02-2026 11:00:00', 'Booked'], ['11-02-2026 19:30:00', 'Inscan']),
      'Out For Delivery': scans(['11-02-2026 11:00:00', 'Booked'], ['12-02-2026 09:00:00', 'RunSheet Prepared']),
      Delivered: scans(['11-02-2026 11:00:00', 'Booked'], ['12-02-2026 15:00:00', 'Delivery Done']),
    };
    for (const entry of entries.filter((candidate) => candidate.confirmedBy === 'official-doc')) {
      expect(parseTej(badges[entry.wording], IN_TRANSIT).current_stage, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'tej-couriers', providerCode: null, description: 'RunSheet Prepared By SAMPLE NAME' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'tej-couriers', providerCode: null, description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});
