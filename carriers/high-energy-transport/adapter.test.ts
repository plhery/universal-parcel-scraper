import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HIGH_ENERGY_TRANSPORT } from './adapter.js';
import { dispatchTrackNumber, dispatchTrackSnapshotUrl, dispatchTrackWidgetUrl, parseDispatchTrack } from './dispatchtrack.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's snapshot, with the recipient, the drop address, its map position, the driver and the live channel
// left out. Its promised window holds a time unrelated to the delivery.
const SAMPLE = '2341461';
const OTHER = 'ZZ9000001';

type Snapshot = Record<string, unknown> & { eta: Record<string, unknown> };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Snapshot;
const snapshot = (changes: Record<string, unknown> = {}) => ({ ...fixture(`snapshot-${SAMPLE}`), ...changes });
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** An order widget's reply with one order and the events given. */
const widget = (order: Record<string, unknown>) => ({
  success: true, service_orders: [{ order_ship_events: [], ...order }], business: { track_code: 'f7ea831', name: 'High Energy Transport' }, total_orders: 1,
});

describe('High Energy Transport numbers', () => {
  it('takes an order reference in letters and digits', () => {
    expect(dispatchTrackNumber(HIGH_ENERGY_TRANSPORT, ' r3947 ')).toBe('R3947');
    for (const other of ['', 'AB', '2341461!', 'X'.repeat(41)]) {
      expect(() => dispatchTrackNumber(HIGH_ENERGY_TRANSPORT, other), other).toThrow('order numbers are letters and digits');
    }
  });
});

describe('High Energy Transport tracking adapter', () => {
  it('asks the snapshot its tracker page’s frame asks, and nothing else when it labels the order with the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(snapshot()));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered', summary_only: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://highenergytransport.dispatchtrack.com/api/v1/order_tracker/f7ea831?phone_number=2341461');
    expect(String(url)).toBe(dispatchTrackSnapshotUrl(HIGH_ENERGY_TRANSPORT, SAMPLE));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'high-energy-transport', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s not-found answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps its reCAPTCHA check, refusals, error pages and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => json({ captcha_error: true, error: { message: 'Access Error' } }, { status: 422 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ error: 'Unprocessable' }, { status: 422 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({ error: 'Not Found' }, { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => new Response('<title>Error</title>', { status: 500, headers: { 'Content-Type': 'text/html' } })))
      .not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => new Response('<html><title>Just a moment...</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response('<html><title>Order Track</title></html>', { headers: { 'Content-Type': 'text/html' } })))
      .toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.dispatchtrack.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });

  it('binds a snapshot labelled with another number through the order widget', async () => {
    const reference = (order: Record<string, unknown>) => vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => json(snapshot()))
      .mockImplementationOnce(async () => json(widget(order)));
    const found = reference({ service_order_number: SAMPLE, reference_number: OTHER });
    await expect(carrier(found).track({ number: OTHER })).resolves.toMatchObject({ current_stage: 'delivered', summary_only: true });
    expect(String(found.mock.calls[1]![0])).toBe('https://highenergytransport.dispatchtrack.com/track_orders/f7ea831/ZZ9000001');
    expect(String(found.mock.calls[1]![0])).toBe(dispatchTrackWidgetUrl(HIGH_ENERGY_TRANSPORT, OTHER));
    // The widget's order names neither number, or is another order than the snapshot's.
    await expect(carrier(reference({ service_order_number: SAMPLE, reference_number: 'ZZ9000002' })).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(reference({ service_order_number: 'ZZ9000003', reference_number: OTHER })).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

describe('High Energy Transport replies', () => {
  it('reads the public sample: a delivered order without events, its promised window left unread', () => {
    expect(parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot(), SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      provider_code: 'completed', last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
  });

  it('reads the delivery window in the zone the reply states', () => {
    const scheduled = snapshot({ stage: 'assigned', statusLabel: 'Scheduled', displayStatus: 'Delivery Scheduled' });
    expect(parseDispatchTrack(HIGH_ENERGY_TRANSPORT, scheduled, SAMPLE)).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', last_status_text: 'Delivery Scheduled',
      provider_code: 'assigned', last_update: null,
      expected_delivery_from: '2024-06-05T12:30:00-04:00', expected_delivery: '2024-06-05T15:30:00-04:00', summary_only: true, events: [],
    });
    const eta = (changes: Record<string, unknown>) => parseDispatchTrack(HIGH_ENERGY_TRANSPORT,
      { ...scheduled, eta: { ...scheduled.eta, ...changes } }, SAMPLE);
    // Without a zone the window keeps its wall clock; without a window, or with a zone it cannot read, the day.
    expect(eta({ timeZone: null })).toMatchObject({ expected_delivery: '2024-06-05 12:30–15:30' });
    expect(eta({ etaLabel: '' })).toMatchObject({ expected_delivery: '2024-06-05' });
    expect(eta({ timeZone: 'Mars/Olympus' })).toMatchObject({ expected_delivery: '2024-06-05' });
    // A weekday that disagrees with its date, or no date, gives no estimate.
    expect(eta({ dateLabel: 'Tuesday 5th, June 2024' })).toMatchObject({ expected_delivery: null });
    expect(eta({ dateLabel: '' })).toMatchObject({ expected_delivery: null });
  });

  it('keeps a stage it does not know without one', () => {
    expect(parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot({ stage: 'unassigned', displayStatus: 'Order Received' }), SAMPLE))
      .toMatchObject({ status: 'unknown', last_status_text: 'Order Received', provider_code: 'unassigned', summary_only: true });
  });

  it('refuses a snapshot for another number, another firm or of another shape', () => {
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot(), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot({ tenantId: 'mxd' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot({ type: 'order.delta' }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot({ shortLabel: null }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, snapshot({ stage: 7 }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDispatchTrack(HIGH_ENERGY_TRANSPORT, fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('High Energy Transport statuses', () => {
  it('maps each stage code of DispatchTrack’s snapshot', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'high-energy-transport', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('unassigned', 'Order Received')).toBeUndefined();
  });
});
