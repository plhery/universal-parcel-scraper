import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, AIRMEE_LOOKUP, AirmeeTracker, airmeeLookupUrl } from './adapter.js';
import { normalizeAirmeeNumber, parseAirmee } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies, with the recipient's town, postcode and the courier's positions taken out.
const RETURNED = 'AM016047991';
const DELIVERED = 'AM010034806';
const INVENTED = 'AM000000000';

type Reply = { statusCode: number; body: string };
type Shipment = Record<string, unknown> & { events_timeline: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const shipmentOf = (name: string) => JSON.parse(fixture(name).body) as Shipment;
const replyOf = (shipment: Record<string, unknown>) => ({ statusCode: 200, body: JSON.stringify(shipment) });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (status_: string, time: string, extra: Record<string, unknown> | null = null, warehouse: string | null = null) => ({
  status_, time_of_event: time, warehouse_name: warehouse, extra_information: extra,
});

describe('Airmee numbers', () => {
  it('takes letters and digits with at least one digit', () => {
    expect(normalizeAirmeeNumber(` ${RETURNED.toLowerCase()} `)).toBe(RETURNED);
    expect(normalizeAirmeeNumber('e8855c')).toBe('E8855C');
    for (const other of ['', 'AM1', 'ABCDEF', 'AM0000!0000', `${'A'.repeat(40)}1`]) {
      expect(() => normalizeAirmeeNumber(other), other).toThrow('4 to 40 letters and digits');
    }
  });
});

describe('Airmee tracking adapter', () => {
  it("asks the tracking page's public lookup for the id over the whole date range", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const tracker = new AirmeeTracker({ fetcher, recorder: NOOP_RECORDER, now: () => new Date('2026-11-28T23:30:00Z') });
    await expect(tracker.fetch(DELIVERED.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${AIRMEE_LOOKUP}?shipment_id=${DELIVERED}&min_date=2018-01-01&max_date=2026-11-29`);
    expect(airmeeLookupUrl(DELIVERED, new Date('2026-12-31T08:00:00Z'))).toMatch(/&max_date=2027-01-01$/);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Origin: 'https://tracking.airmee.com', Referer: 'https://tracking.airmee.com/' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'airmee', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('recognizes a shipment the tracker holds, an empty shipment as unknown, and leaves other answers open', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('delivered'))).mockResolvedValueOnce(json(fixture('not-found')))
      .mockResolvedValueOnce(json({ statusCode: 500, body: '{}' }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true, finished: true, lastActivityAt: expect.any(String) });
    await expect(carrier(fetcher).recognize!(INVENTED)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!(INVENTED)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(fetcher).recognize!('AM1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(detectCarrierMatch(INVENTED)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['airmee']) });
    expect(detectCarrierMatch(`AM${'0'.repeat(10)}`).candidates ?? []).not.toContain('airmee');
  });

  it("reads the tracker's empty shipment as not found", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, block pages, error replies and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => html('<html><title>403 Forbidden</title></html>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><title>Just a moment...</title><script>_cf_chl_opt={}</script></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body>Airmee</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ message: 'Internal server error' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json({ message: 'Service Unavailable' }, { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json({ message: 'Bad Request' }, { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.airmee.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ statusCode: 500, body: '{}' }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json({ statusCode: 200, body: '{' }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ statusCode: 200, body: '[]' }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ message: 'Forbidden' }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Airmee replies', () => {
  it('reads the delivered sample: its rows as the page words them, its warehouses and the retailer', () => {
    expect(parseAirmee(fixture('delivered'), DELIVERED)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2024-12-03T21:05:25Z', expected_delivery: null,
      sender_name: 'Amazon', destination_country: 'SE',
      events: [
        { time: '2024-12-03T21:05:25Z', description: 'Delivered', provider_code: 'DROPOFF_CONFIRMED', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2024-12-03T21:02:30Z', description: 'Delivery in progress', provider_code: 'ON_WAY_TO_DROPOFF', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2024-12-03T15:41:10Z', description: 'Out for Delivery', provider_code: 'PICKUP_CONFIRMED', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2024-12-02T07:42:05Z', description: 'In Transit', location: 'Airmee Farsta Warehouse', provider_code: 'SCAN', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2024-12-01T08:09:52Z', description: 'Delivery Delayed', provider_code: 'POSTPONED_OTHER', stage: 'exception', stage_source: 'carrier_map' },
        { time: '2024-11-30T12:19:40Z', description: 'In Transit', location: 'Airmee Farsta Warehouse', provider_code: 'SCAN', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2024-11-30T10:02:22Z', description: 'Delivery Attempt Failed', provider_code: 'POSTPONED_UNREACHABLE_CUSTOMER', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { time: '2024-11-30T10:01:33Z', description: 'Delivery in progress', provider_code: 'ON_WAY_TO_DROPOFF', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        // Two loadings two minutes apart: the run keeps its first.
        { time: '2024-11-30T08:15:37Z', description: 'Out for Delivery', provider_code: 'PICKUP_CONFIRMED', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2024-11-30T07:36:39Z', description: 'In Transit', location: 'Airmee Farsta Warehouse', provider_code: 'SCAN', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2024-11-29T19:40:56Z', description: 'In Transit', location: 'Airmee Malmö Warehouse', provider_code: 'SCAN', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2024-11-29T01:47:57Z', description: 'Shipment Booked', provider_code: 'UNASSIGNED', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads the returned sample: the trip back after the attempts ran out, and no estimate', () => {
    const result = parseAirmee(fixture('returned'), RETURNED);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'returned', last_status_text: 'Returned', last_update: '2025-09-08T12:23:53Z',
      expected_delivery: null, sender_name: 'Amazon', destination_country: 'SE',
    });
    expect(result.events!.slice(0, 5).map(({ description, location, stage }) => [description, location, stage])).toEqual([
      ['Returned', undefined, 'returned'],
      // A warehouse scan that names no leg, after the return began, is on the way back.
      ['In Return Transit', 'Airmee Gothenburg Warehouse', 'returned'],
      ['Return in progress', undefined, 'returned'],
      ['In Transit', 'Airmee Gothenburg Warehouse', 'in_transit'],
      ['Delivery Attempt Failed', undefined, 'failed_attempt'],
    ]);
    // The tracker repeats the van's drive to the door as it moves: each round keeps its first row.
    expect(result.events!.filter(({ description }) => description === 'Delivery in progress').map(({ time }) => time))
      .toEqual(['2025-09-07T19:24:27Z', '2025-09-06T19:15:21Z']);
    expect(result.events).toHaveLength(14);
  });

  it('gives the drop-off window of a delivery not yet made, in the recipient zone', () => {
    const shipment = shipmentOf('delivered');
    const open = { ...shipment, courier_status: 'PICKUP_CONFIRMED', events_timeline: shipment.events_timeline.slice(2) };
    expect(parseAirmee(replyOf(open), DELIVERED)).toMatchObject({
      current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery',
      expected_delivery: '2024-12-03T22:00:00+01:00', expected_delivery_from: '2024-12-03T17:00:00+01:00',
    });
    const unread = { ...open, dropoff_earliest_time: '1733259600', dropoff_latest_time: 'soon' };
    expect(parseAirmee(replyOf(unread), DELIVERED)).toMatchObject({
      expected_delivery: null, unread_estimates: ['dropoff_earliest_time', 'dropoff_latest_time'],
    });
  });

  it("words a retailer's return collection by its leg, names no sender, and lets a date change move nothing", () => {
    const back = { type_of_delivery: 'return', type_of_service: 'home_delivery' };
    const shipment = {
      ...shipmentOf('delivered'), order_metadata: 'return', courier_status: 'PICKUP_CONFIRMED',
      events_timeline: [
        row('EDIT', '2026-01-05T09:00:00+00:00', { ...back, reason: 'requested_by_customer' }),
        row('SCAN', '2026-01-04T18:00:00+00:00', back, 'Airmee Example Warehouse'),
        row('PICKUP_CONFIRMED', '2026-01-04T15:00:00+00:00', back),
        row('ON_WAY_TO_PICKUP', '2026-01-04T14:00:00+00:00', back),
        row('UNASSIGNED', '2026-01-03T10:00:00+00:00', back),
      ],
    };
    const result = parseAirmee(replyOf(shipment), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Return Date Updated by Customer', expected_delivery: null });
    expect(result).not.toHaveProperty('sender_name');
    expect(result.events!.map(({ description, stage }) => [description, stage])).toEqual([
      ['Return Date Updated by Customer', undefined],
      ['In Return Transit', 'returned'],
      ['Return Collected', 'returned'],
      ['Pickup in Progress', 'registered'],
      ['Pickup Booked', 'registered'],
    ]);
  });

  it('stands on the courier status without rows, and keeps a shipment without either open', () => {
    const shipment = { ...shipmentOf('delivered'), courier_status: 'DROPOFF_CONFIRMED', events_timeline: [] };
    expect(parseAirmee(replyOf(shipment), DELIVERED)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DROPOFF_CONFIRMED', last_status_text: 'Delivered', summary_only: true, events: [],
    });
    expect(() => parseAirmee(replyOf({ ...shipment, courier_status: 'SOMETHING_NEW' }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a reply for another shipment and a malformed timeline', () => {
    const shipment = shipmentOf('delivered');
    expect(() => parseAirmee(replyOf(shipment), INVENTED)).toThrow('another shipment');
    expect(() => parseAirmee(replyOf({ ...shipment, events_timeline: {} }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirmee(replyOf({ ...shipment, events_timeline: [row('SCAN', '2024-12-02 07:42')] }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirmee(replyOf({ ...shipment, events_timeline: [row('', '2024-12-02T07:42:05Z')] }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it("answers every code and label statuses.json records by Airmee's map", () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'airmee', providerCode: entry.code, description: entry.wording });
      expect(answer, `${entry.code} ${entry.wording}`).toEqual(entry.stage
        ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap', note: expect.any(String) });
      // A label read alone, as a universal provider relays it, gets the same stage.
      if (entry.stage) expect(statusMapAnswer({ carrier: 'airmee', providerCode: null, description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});
