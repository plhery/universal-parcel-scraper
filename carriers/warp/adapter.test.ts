import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeWarpNumber, parseWarp, WARP_STOPS, WARP_TRACKING } from './adapter.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies, trimmed of the customer, stop names, streets, references, coordinates and proof links.
const ORDER = 'P-0044-2639', SHIPMENT = 'S-37768-2639', CANCELED = 'S-80215-2616';
const UNKNOWN = 'S-00000-0000';

type Reply = { shipments: Record<string, unknown>[]; order: Record<string, unknown>; events: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const delivered = () => fixture(`order-${ORDER}`);
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The delivered sample with its shipment's status and events replaced. */
const reply = (status: string, events: [string, string, number][], extra: Record<string, unknown> = {}) => {
  const base = delivered();
  const id = base.shipments[0]!.id;
  return { ...base, shipments: [{ ...base.shipments[0], status, ...extra }],
    events: events.map(([code, title, ts]) => ({ object: id, ts, status: code, title })) };
};

describe('WARP numbers', () => {
  it('takes a shipment or order number, with or without its hyphens', () => {
    expect(normalizeWarpNumber(` ${SHIPMENT.toLowerCase()} `)).toBe(SHIPMENT);
    expect(normalizeWarpNumber('S377682639')).toBe(SHIPMENT);
    expect(normalizeWarpNumber('p00442639')).toBe(ORDER);
    expect(normalizeWarpNumber('S-199806-2617')).toBe('S-199806-2617');
    for (const other of ['', 'S-12-2639', 'X-37768-2639', 'S-37768-263', 'S37768', 'S-1234567890-2639']) {
      expect(() => normalizeWarpNumber(other), other).toThrow('WARP shipment or order number');
    }
  });
});

describe('WARP tracking adapter', () => {
  it('asks the tracking page’s service for the code with its hyphens and the events’ titles', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(delivered()));
    await expect(carrier(fetcher).track({ number: 'p00442639' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${WARP_TRACKING}${ORDER}?fe=true`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'warp', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads an empty 404 as not found once the stops service says it does not know the code', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(null, { status: 404, headers: { 'Content-Type': 'text/plain' } }))
      .mockImplementationOnce(async () => json(fixture('not-found'), { status: 400 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${WARP_TRACKING}${UNKNOWN}?fe=true`, `${WARP_STOPS}${UNKNOWN}/stops`]);
  });

  it('keeps refusals, error pages and unexplained answers apart from a missing shipment', async () => {
    const answer = async (...responses: (() => Response)[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const response of responses) fetcher.mockImplementationOnce(async () => response());
      fetcher.mockImplementation(async () => responses.at(-1)!());
      return carrier(fetcher).track({ number: SHIPMENT }, { budgetMs: 2000 }).catch((error: unknown) => error);
    };
    const empty404 = () => new Response(null, { status: 404, headers: { 'Content-Type': 'text/plain' } });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('Endpoint GET / not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })))
      .toMatchObject({ kind: 'indeterminate' });
    expect(await answer(empty404, () => json({ message: 'Something else' }, { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(empty404, () => json(delivered()))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => new Response('<title>Just a moment...</title>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('java.lang.NumberFormatException', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.wearewarp.com/' } })))
      .not.toMatchObject({ kind: 'not_found' });
  });
});

describe('WARP replies', () => {
  it('reads the delivered sample: its events as instants, where the driver stopped and the shipment’s end', () => {
    const result = parseWarp(delivered(), ORDER);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'complete',
      last_status_text: 'Delivered', last_update: '2026-09-25T16:19:56.461Z', expected_delivery: null,
      events: [
        { time: '2026-09-25T16:19:56.461Z', description: 'Delivered', provider_code: 'delivered', location: 'Haverhill, MA', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-09-25T16:13:07.274Z', description: 'Arrived at Dropoff Location', provider_code: 'arrivedAtDropoff', location: 'Haverhill, MA', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-09-25T15:04:35.408Z', description: 'En Route to dropoff', provider_code: 'outForDelivery', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-09-25T14:53:45.320Z', description: 'Driver arrived at pickup location', provider_code: 'arrivedAtPickup', location: 'Rollinsford, NH', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-09-25T12:12:48.282Z', description: 'Driver en-route to pickup location', provider_code: 'inRouteToPickup', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-09-25T01:23:32.529Z', description: 'Driver Assigned', provider_code: 'booked', stage: 'registered', stage_source: 'carrier_map' },
        { time: '2026-09-24T18:50:46.930Z', description: 'Order received', provider_code: 'create', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The same shipment by its own number; the customer, stops, streets and references stay behind.
    expect(parseWarp(delivered(), SHIPMENT)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/0386|0183|PALLET|lbs|SHIPMENT_|ORDER_|pod/i);
  });

  it('reads the canceled sample without the delivery window it no longer has', () => {
    expect(parseWarp(fixture(`shipment-${CANCELED}`), CANCELED)).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'canceled', last_status_text: 'Shipment Canceled', expected_delivery: null,
      events: [{ provider_code: 'canceled', stage: 'exception' }, { provider_code: 'create', stage: 'registered' }],
    });
  });

  it('gives a moving shipment its drop-off window and the stage of its newest event', () => {
    const etas = [
      { window: { from: '2026-09-28T12:00:00Z', to: '2026-09-28T13:00:00Z' }, type: 'scheduled', destinationType: 'PICKUP' },
      { window: { from: '2026-09-29T15:00:00Z', to: '2026-09-29T22:00:00Z' }, type: 'scheduled', destinationType: 'DROPOFF' },
    ];
    const moving = parseWarp(reply('inRouteToWareHouse', [['create', 'Order received', 1790275846930], ['pickedUp', 'Picked up', 1790348025320],
      ['deliveryConfirmed', 'Delivery appointment confirmed', 1790348675408]], { etas }), SHIPMENT);
    expect(moving).toMatchObject({ current_stage: 'in_transit', provider_code: 'inRouteToWareHouse', last_status_text: 'Delivery appointment confirmed',
      expected_delivery: '2026-09-29T22:00:00Z', expected_delivery_from: '2026-09-29T15:00:00Z' });
    expect(moving.events![0]).toEqual({ time: '2026-09-25T15:04:35.408Z', description: 'Delivery appointment confirmed', provider_code: 'deliveryConfirmed' });
    // A status behind the events gives way to them. A departure titled out for delivery is the last leg;
    // an unknown code keeps its wording without a stage.
    expect(parseWarp(reply('needCarrier', [['departedFacility', 'Out for delivery', 1790348025320]]), SHIPMENT))
      .toMatchObject({ current_stage: 'out_for_delivery' });
    expect(parseWarp(reply('needCarrier', [['departedFacility', 'Departed WARP facility', 1790348025320]]), SHIPMENT))
      .toMatchObject({ current_stage: 'in_transit' });
    expect(parseWarp(reply('needCarrier', [['somethingNew', 'Something new', 1790348025320]]), SHIPMENT))
      .toMatchObject({ current_stage: 'registered', events: [{ description: 'Something new', provider_code: 'somethingNew' }] });
  });

  it('answers a shipment of an order with several only by its own number', () => {
    const base = delivered();
    const other = { ...base.shipments[0], id: 'SHIPMENT_OTHER', proNumber: 'S-37769-2639', status: 'needCarrier' };
    const order = { ...base, shipments: [base.shipments[0]!, other], events: [...base.events, { object: 'SHIPMENT_OTHER', ts: 1790353200000, status: 'create', title: 'Order received' }] };
    expect(parseWarp(order, SHIPMENT)).toMatchObject({ current_stage: 'delivered', events: { length: 7 } });
    expect(parseWarp(order, 'S-37769-2639')).toMatchObject({ current_stage: 'registered', events: [{ provider_code: 'create' }] });
    expect(() => parseWarp(order, ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWarp(delivered(), 'S-37770-2639')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const base = delivered();
    for (const changed of [null, {}, { ...base, shipments: {} }, { ...base, order: null }, { ...base, events: [7] },
      { ...base, events: [{ ...base.events[0], ts: 'yesterday' }] }, { ...base, events: [{ ...base.events[0], status: '?' }] },
      { ...base, shipments: [{ ...base.shipments[0], id: '' }] }, { ...base, shipments: [{ ...base.shipments[0], status: 'not a code' }] }]) {
      expect(() => parseWarp(changed, ORDER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('WARP statuses', () => {
  it('maps each code it records, and leaves appointment notices without a stage', () => {
    for (const entry of statuses.entries as { code: string; wording?: string; stage: string | null }[]) {
      expect(statusMap.stage(entry.code, entry.wording?.toLowerCase() ?? ''), entry.code).toBe(entry.stage ?? undefined);
      expect(statusMapAnswer({ carrier: 'warp', providerCode: entry.code, description: entry.wording ?? 'Any title' }))
        .toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage('somethingNew', 'anything')).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
  });
});
