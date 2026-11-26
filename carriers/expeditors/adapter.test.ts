import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, expeditorsDetailUrl, expeditorsSearchUrl } from './adapter.js';
import { normalizeExpeditorsNumber, parseExpeditors, pickExpeditorsShipment } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Json = Record<string, unknown>;
// Two public samples (numbers.json): an air shipment on its last leg and a delivered ocean shipment. Their
// replies keep the carriers' wording and clocks; the customer reference is invented. The third number is invented.
const AIR = '45N0026043';
const OCEAN = '62G0171283';
const UNKNOWN = '99Z9999999';
const fixture = (name: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const shipment = fixture(`shipment-${AIR}`);
const events = fixture(`events-${AIR}`);
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
const routes = (answers: { search?: () => Response; details?: () => Response; events?: () => Response }) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const address = String(url);
    if (address.includes('/guest-shipment-search?')) return (answers.search ?? (() => json(shipment)))();
    if (address.endsWith('/details')) return (answers.details ?? (() => json(shipment)))();
    return (answers.events ?? (() => json(events)))();
  });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, userAgent: 'Expeditors test agent', recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const named = (reference: string, body: Json = shipment): Json => ({ ...body,
  shipmentAttributes: { ...(body.shipmentAttributes as Json), expeditorsReference: reference } });

describe('Expeditors numbers', () => {
  it('takes an Expeditors reference: two digits, a letter or a digit, and seven digits', () => {
    expect(normalizeExpeditorsNumber(` ${AIR.toLowerCase()} `)).toBe(AIR);
    expect(normalizeExpeditorsNumber('4000000000')).toBe('4000000000');
    for (const other of ['', '45N002604', '45N00260431', 'N450026043', '45NN026043', `${AIR},${AIR}`, 'X'.repeat(80)]) {
      expect(() => normalizeExpeditorsNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reads the reference from a guest tracking link', () => {
    for (const path of ['tracking-results/shipments', 'shipments']) {
      expect(parseTrackingInput(`https://go2expo.expeditors.com/anonymous-track/${path}/${UNKNOWN}`))
        .toMatchObject({ trackingNumber: UNKNOWN, carrier: 'expeditors' });
    }
    expect(parseTrackingInput(`https://go2expo.expeditors.com/anonymous-track/tracking-results/shipments/${UNKNOWN}/events`))
      .toMatchObject({ trackingNumber: UNKNOWN, carrier: 'expeditors' });
  });
});

describe('Expeditors tracking adapter', () => {
  it('searches for the reference and reads the events of the shipment it names', async () => {
    const fetcher = routes({});
    await expect(carrier(fetcher).track({ number: AIR })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `https://go2expo-api.expeditors.com/api/visibility/guest-shipment-search?searchReference=${AIR}`,
      `https://go2expo-api.expeditors.com/api/visibility/shipment-detail/${AIR}/events`,
    ]);
    expect(expeditorsSearchUrl(AIR)).toBe(String(fetcher.mock.calls[0]![0]));
    expect(expeditorsDetailUrl(AIR, 'details')).toBe(`https://go2expo-api.expeditors.com/api/visibility/shipment-detail/${AIR}/details`);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      const headers = new Headers(init?.headers);
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('User-Agent')).toBe('Expeditors test agent');
    }
    expect(carrier(fetcher)).toMatchObject({ id: 'expeditors', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the details of the shipment a search lists among others', async () => {
    const fetcher = routes({ search: () => json({ shipmentResults: [named('11A1111111'), named(AIR)] }) });
    await expect(carrier(fetcher).track({ number: AIR })).resolves.toMatchObject({ last_status_text: 'Trucker Notified' });
    expect(fetcher.mock.calls.map(([url]) => String(url)).slice(1).sort()).toEqual([
      expeditorsDetailUrl(AIR, 'details'), expeditorsDetailUrl(AIR, 'events'),
    ]);
  });

  it('reads an empty search as not found, and a search that matched other shipments as undetermined', async () => {
    const answer = (search: unknown) => carrier(routes({ search: () => json(search) })).track({ number: UNKNOWN }).catch((error: unknown) => error);
    expect(await answer(fixture('not-found'))).toMatchObject({ kind: 'not_found' });
    // The search also matches customer references; a shipment found by one of them is another shipment.
    for (const other of [shipment, { shipmentResults: [shipment] }, { shipmentResults: [shipment, named('11A1111111')] }]) {
      expect(await answer(other)).toMatchObject({ kind: 'indeterminate', reason: 'reference_only' });
    }
  });

  it('keeps refusals, error pages and moved routes apart from a missing shipment', async () => {
    const answer = async (response: () => Response, which: 'search' | 'details' | 'events' = 'search') =>
      carrier(routes({ search: () => json({ shipmentResults: [named(AIR)] }), [which]: response }))
        .track({ number: AIR }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    for (const which of ['search', 'details', 'events'] as const) {
      expect(await answer(() => json('', { status: 500 }), which)).not.toMatchObject({ kind: 'not_found' });
      expect(await answer(() => html('<title>404</title>', 404), which)).toMatchObject({ kind: 'transport' });
      expect(await answer(() => html('<title>Just a moment...</title>'), which)).toMatchObject({ kind: 'challenge' });
    }
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.expeditors.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html>Server Error</html>'))).toMatchObject({ kind: 'schema' });
  });

  it('ends the other request when one fails', async () => {
    let aborted = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/events')) {
        return new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason); }));
      }
      return String(url).endsWith('/details') ? json('', { status: 403 }) : json({ shipmentResults: [named(AIR)] });
    });
    await expect(carrier(fetcher).track({ number: AIR }, { budgetMs: 2000 })).rejects.not.toMatchObject({ kind: 'not_found' });
    expect(aborted).toBe(true);
  });
});

describe('Expeditors replies', () => {
  it('reads a shipment on its last leg: scans on their local clocks, the estimates apart', () => {
    const result = parseExpeditors(shipment, events, AIR);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Trucker Notified', last_update: '2026-02-02T15:45:00Z', expected_delivery: '2026-02-02', weight_kg: 748,
    });
    // The status change the events section leaves out leads, in UTC as the reply gives it alone.
    expect(result.events!.slice(0, 3)).toEqual([
      { time: '2026-02-02T15:45:00Z', description: 'Trucker Notified', stage: 'in_transit', stage_source: 'carrier_map' },
      { time: '2026-02-02T07:45:00-06:00', description: 'At Final Destination', location: 'MINNEAPOLIS/ST PAUL, MN (MSP)', stage: 'in_transit', stage_source: 'carrier_map' },
      // A leg from one place to another names no single place.
      { time: '2026-02-01T21:30:00-06:00', description: 'Onforwarded', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.map((event) => event.description)).not.toContain('Requested Delivery Date');
    expect(result.events).toHaveLength(14);
    expect(result.events!.at(-1)).toEqual({ time: '2026-01-26T15:00:00+08:00', description: 'Vendor Called for Booking', stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === 'Broker Notified')).toEqual({ time: '2026-01-26T16:56:00+08:00', description: 'Broker Notified' });
    expect(result.planned_events).toEqual([
      { time: '2026-01-27T00:00:00-06:00', description: 'Requested Delivery Date' },
      { time: '2026-01-29T12:00:00Z', description: 'Estimated Time of Arrival', location: 'CHICAGO, IL (ORD)' },
      { time: '2026-01-30T00:11:00-06:00', description: 'Est Arr Port of Unlading' },
      { time: '2026-02-02T08:00:00-06:00', description: 'Est Arrival at Dest', location: 'MINNEAPOLIS/ST PAUL, MN (MSP)' },
      { time: '2026-02-02T17:00:00-06:00', description: 'Est Delivery to Consignee' },
    ]);
  });

  it('reads a shipment Expeditors handed to its client’s trucker as delivered, without estimates', () => {
    const result = parseExpeditors(fixture(`shipment-${OCEAN}`), fixture(`events-${OCEAN}`), OCEAN);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Services Completed: Turned Over to Client Trucker',
      last_update: '2026-01-23T11:28:00-05:00', expected_delivery: null, weight_kg: 459,
    });
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events!.map((event) => event.description)).toContain('Turned Over to Dispatch');
    expect(result.events!.at(-2)).toEqual({ time: '2025-11-25T18:00:00+05:30', description: 'Freight Received No Docs', stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2025-11-24T12:00:00Z', description: 'Vendor Called for Booking' });
  });

  it('never carries the customer reference, the carrier, its flight or vessel, the parties or the remarks', () => {
    const remarked = { shipmentAttributes: { ...(events.shipmentAttributes as Json),
      events: ((events.shipmentAttributes as Json).events as Json[]).map((row) => ({ ...row, remarks: 'Invented remark' })) } };
    const parties = { ...shipment, consignee: { name: 'Invented Consignee' }, shipper: { name: 'Invented Shipper', phone: '0000000000' } };
    for (const result of [parseExpeditors(parties, remarked, AIR), parseExpeditors(fixture(`shipment-${OCEAN}`), fixture(`events-${OCEAN}`), OCEAN)]) {
      const text = JSON.stringify(result);
      for (const value of ['PO - 99999999', 'QANTAS', '7521', 'MADRID EXPRESS', 'Maersk', '549E', 'Invented', '0000000000']) {
        expect(text).not.toContain(value);
      }
    }
  });

  it('counts the status change once when the events list it too, and keeps the time of a wall clock that names no offset in UTC', () => {
    const rows = (events.shipmentAttributes as Json).events as Json[];
    const withChange = { shipmentAttributes: { ...(events.shipmentAttributes as Json), events: [
      { event: { description: 'Trucker Notified', date: '2026-02-02T15:45:00Z', formattedDate: '02-Feb-2026 09:45 CST' } }, ...rows] } };
    const result = parseExpeditors(shipment, withChange, AIR);
    expect(result.events!.filter((event) => event.description === 'Trucker Notified')).toEqual([
      { time: '2026-02-02T09:45:00-06:00', description: 'Trucker Notified', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    const odd = { shipmentAttributes: { ...(events.shipmentAttributes as Json), events: [
      { event: { description: 'Onforwarded', date: '2026-02-02T15:45:00Z', formattedDate: '02-Feb-2026 09:52 CST' } },
      { event: { description: 'Booked', date: '2025-12-31T23:00:00Z', formattedDate: '31-Dec 17:00 CST' } }] } };
    expect(parseExpeditors(shipment, odd, AIR).events!.filter((event) => event.description !== 'Trucker Notified')).toEqual([
      { time: '2026-02-02T15:45:00Z', description: 'Onforwarded', stage: 'in_transit', stage_source: 'carrier_map' },
      // A wall clock without its year takes the year that gives an offset.
      { time: '2025-12-31T17:00:00-06:00', description: 'Booked', stage: 'registered', stage_source: 'carrier_map' },
    ]);
  });

  it('reads a listed shipment without scans as no history, its estimates kept', () => {
    const plain = { ...shipment, shipmentStatus: { description: 'Booked' } };
    const estimates = { shipmentAttributes: { expeditorsReference: AIR, events: [
      { event: { description: 'Est Delivery to Consignee', date: '2026-02-02T23:00:00Z', formattedDate: '02-Feb-2026 17:00 CST' } },
      { event: { description: 'Estimated Time of Arrival', date: '', formattedDate: '' } }] } };
    expect(() => parseExpeditors(plain, estimates, AIR)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed',
      plannedEvents: [{ time: '2026-02-02T17:00:00-06:00', description: 'Est Delivery to Consignee' }] }));
  });

  it('falls back on the estimated delivery the shipment’s arrival status gives', () => {
    const rows = ((events.shipmentAttributes as Json).events as Json[]).filter((row) => (row.event as Json).description !== 'Est Delivery to Consignee');
    const result = parseExpeditors(shipment, { shipmentAttributes: { expeditorsReference: AIR, events: rows } }, AIR);
    expect(result.expected_delivery).toBe('2026-02-02');
  });

  it('picks the shipment the search names, and nothing else', () => {
    expect(pickExpeditorsShipment(shipment, AIR)).toEqual({ shipment });
    expect(pickExpeditorsShipment({ shipmentResults: [named(OCEAN), named(AIR)] }, AIR)).toEqual({ shipment: null });
    expect(() => pickExpeditorsShipment({ shipmentResults: [] }, AIR)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('refuses a changed reply or one about another shipment', () => {
    const rows = (events.shipmentAttributes as Json).events as Json[];
    const eventsWith = (row: unknown) => ({ shipmentAttributes: { expeditorsReference: AIR, events: [row] } });
    for (const [details, list] of [
      [named(OCEAN), events], [shipment, { shipmentAttributes: { ...(events.shipmentAttributes as Json), expeditorsReference: OCEAN } }],
      [null, events], [shipment, null], [{ ...shipment, shipmentAttributes: {} }, events],
      [shipment, { shipmentAttributes: { expeditorsReference: AIR } }], [shipment, eventsWith(null)], [shipment, eventsWith({})],
      [shipment, eventsWith({ ...rows[2], event: { description: '', date: '2026-02-02T13:45:00Z' } })],
      [shipment, eventsWith({ event: { description: 'Onforwarded', date: '02-Feb-2026 07:45' } })],
      [shipment, eventsWith({ event: { description: 'Onforwarded', date: '' } })],
    ] as const) {
      expect(() => parseExpeditors(details, list, AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const search of [null, [], { shipmentResults: {} }, { shipmentResults: [{}] }, { shipmentResults: Array(501).fill(shipment) }]) {
      expect(() => pickExpeditorsShipment(search, AIR)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Expeditors statuses', () => {
  it('maps each wording the service returned, and leaves the gaps on purpose', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'expeditors', providerCode: null, description: entry.wording }), entry.wording)
        .toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage(null, 'zzz')).toBeUndefined();
  });
});
