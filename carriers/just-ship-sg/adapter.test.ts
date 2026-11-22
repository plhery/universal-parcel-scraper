import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JUST_SHIP_LOOKUP } from './adapter.js';
import { normalizeJustShipNumber, parseJustShip } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply; the tests derive invented shipments from it.
const SAMPLE = '240915A001R01';
const OTHER = '250101A999R99';

type Reply = { shipment: Record<string, unknown> | null; trackingHistory?: unknown; trackingInfo?: unknown };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const sample = () => fixture(`shipment-${SAMPLE}`);
/** The sample under the invented shipping ID, with its history and carrier replaced when given. */
const reply = (changes: { history?: unknown; info?: unknown; shipment?: Record<string, unknown> } = {}): Reply => {
  const base = sample();
  return {
    shipment: { ...base.shipment, shippingID: OTHER, ...changes.shipment },
    trackingHistory: 'history' in changes ? changes.history : base.trackingHistory,
    trackingInfo: 'info' in changes ? changes.info : base.trackingInfo,
  };
};
const scan = (status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ status, createdAt, name: status, payload: null, ...extra });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JustShip numbers', () => {
  it('takes a shipping ID with or without the hyphen the page prints after its date', () => {
    expect(normalizeJustShipNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeJustShipNumber('240915-A001R01')).toBe(SAMPLE);
    expect(normalizeJustShipNumber('240915_A001R01')).toBe(SAMPLE);
    for (const other of ['', '240915', '2409150001001', 'A240915001R01', '240915A0', '240915A001R01P01X1', '24091!A001R01']) {
      expect(() => normalizeJustShipNumber(other), other).toThrow('shipping ID JustShip gave');
    }
  });
});

describe('JustShip tracking adapter', () => {
  it('asks the service the tracking page asks, with the shipping ID', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(sample()));
    await expect(carrier(fetcher).track({ number: '240915-a001r01' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${JUST_SHIP_LOOKUP}?trackingNumber=${SAMPLE}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'just-ship-sg', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads JustShip’s empty shipment as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps checks, refusals, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
    expect(await answer(() => page('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>')))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('<title>Vercel Security Checkpoint</title>', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => page('<html></html>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => page('', { headers: { 'cf-mitigated': 'challenge' } }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => page('<title>404: This page could not be found</title>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 307, headers: { Location: '/maintenance' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => page('<title>Server error</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => page('<html>JustShip</html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('JustShip replies', () => {
  it('reads the public sample: its history on its instants, its service and the carrier it went with', () => {
    const result = parseJustShip(sample(), SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2024-09-23T17:01:36Z', expected_delivery: null,
      service_name: 'Express Shipping', destination_country: 'DE', delivery_carrier: 'fedex', delivery_tracking_number: '778632108403',
      events: [
        { time: '2024-09-23T17:01:36Z', description: 'Delivered', provider_code: 'delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2024-09-18T08:33:05Z', description: 'Ready for international transit', provider_code: 'ready_for_international_transit',
          stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2024-09-14T16:03:37Z', description: 'Order Created', provider_code: 'created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The recipient's town, the parcel's size and weight and the pickup slot stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Leipzig|1\.96|9:00 am/);
  });

  it('reads JustShip’s empty shipment as not found and refuses another shipment', () => {
    expect(() => parseJustShip(fixture('not-found'), OTHER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJustShip(sample(), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a scan’s state and country and orders the history by its instants', () => {
    const result = parseJustShip(reply({ history: [
      scan('created', '2025-01-01T02:00:00.000Z', { name: 'Order Created' }),
      scan('arrived_dest_sorting_facility', '2025-01-05T09:00:00.000Z', { payload: { location: { state: 'NSW', country: 'AU' } } }),
      scan('held_at_customs', '2025-01-04T09:00:00.000Z', { name: 'Held at customs', payload: { location: { country: 'AU' } } }),
    ] }), OTHER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_update: '2025-01-05T09:00:00Z' });
    expect(result.events!.map((event) => [event.provider_code, event.location ?? null])).toEqual([
      ['arrived_dest_sorting_facility', 'NSW, AU'], ['held_at_customs', 'AU'], ['created', null],
    ]);
  });

  it('leaves an unknown status to the scans before it, and an unknown carrier without a hand-off', () => {
    const result = parseJustShip(reply({ history: [scan('created', '2025-01-01T02:00:00.000Z'), scan('rerouted', '2025-01-02T02:00:00.000Z')],
      info: { shippingProvider: 'Some Courier', trackingNumber: 'SC123456789', url: 'https://example.com/track' } }), OTHER);
    expect(result).toMatchObject({ current_stage: 'registered', last_status_text: 'rerouted', delivery_tracking_number: 'SC123456789' });
    expect(result.delivery_carrier).toBeUndefined();
    expect(result.events![0]).toEqual({ time: '2025-01-02T02:00:00Z', description: 'rerouted', provider_code: 'rerouted' });
    expect(parseJustShip(reply({ info: null }), OTHER)).not.toHaveProperty('delivery_tracking_number');
  });

  it('answers a listed shipment without a history as having none yet', () => {
    expect(() => parseJustShip(reply({ history: [] }), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, { shipment: 'x' }, reply({ shipment: { shippingID: null } }), reply({ history: {} }),
      reply({ history: [scan('Delivered', '2025-01-02T02:00:00.000Z')] }), reply({ history: [scan('delivered', '2025-01-02 02:00')] }),
      reply({ history: ['delivered'] }), reply({ history: [scan('delivered', '2025-01-02T02:00:00.000Z', { payload: 'x' })] }),
      reply({ info: 'FedEx' })]) {
      expect(() => parseJustShip(changed, OTHER), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('JustShip statuses', () => {
  it('maps each status of the tracking page', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'just-ship-sg', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('rerouted', 'anything')).toBeUndefined();
  });
});
