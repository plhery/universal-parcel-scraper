import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, COURIE_API, PHANTOM_COURIER_ID, PhantomTracker, phantomTrackingUrl } from './adapter.js';
import { normalizePhantomNumber, parsePhantom } from './parser.js';
import { phantomShipmentStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// A public sample in numbers.json, and an invented order for the empty answer.
const SAMPLE = '445009';
const UNKNOWN = 'ZZ900000';

type Shipment = Record<string, unknown> & { stops: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as
  { data: { shipmentByTrackingNumber: Shipment | null } };
/** The sample's order, changed by `edit`. */
const order = (edit: (shipment: Shipment) => void = () => {}) => {
  const payload = fixture('delivered');
  edit(payload.data.shipmentByTrackingNumber!);
  return payload;
};
const reply = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Phantom Couriers HTTP adapter', () => {
  it("asks Courie's guest query for the courier's whole order once, through the supplied transport", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PhantomTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 445 009 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(COURIE_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    const body = JSON.parse(String(init!.body)) as { variables: unknown; query: string };
    expect(body.variables).toEqual({ courierId: PHANTOM_COURIER_ID, trackingNumber: SAMPLE });
    // Only the order's status, times and cities: no address, contact, driver, proof or price.
    expect(body.query).not.toMatch(/address|phone|email|contact|driver|artifact|signature|price|lngLat/i);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'phantom-couriers', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
    expect(phantomTrackingUrl(SAMPLE)).toBe('https://portal.courie.ai/phantom/trackshipment?trackingNumber=445009');
  });

  it('dates the order’s milestones newest first, from its creation to the drop-off', () => {
    const result = parsePhantom(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2024-12-03T17:27:39Z', provider_code: 'COMPLETED' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.description, event.location, event.stage])).toEqual([
      ['2024-12-03T17:27:39Z', 'DROP_OFF', 'Delivered', 'Vancouver, BC', 'delivered'],
      ['2024-12-03T17:26:04Z', 'PICK_UP', 'Picked up', 'Vancouver, BC', 'accepted'],
      ['2024-12-03T15:09:46Z', 'ASSIGNED', 'Assigned to a driver', undefined, 'registered'],
      ['2024-12-03T00:45:02Z', 'CREATED', 'Order created', undefined, 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.local_time === undefined)).toBe(true);
  });

  it('reads an attempted drop-off, a return and an order on its way as the portal words them', () => {
    const attempted = parsePhantom(order((shipment) => {
      shipment.completionReason = 'ATTEMPTED';
      shipment.stops[1]!.completionReason = 'ATTEMPTED';
    }), SAMPLE);
    expect(attempted).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', last_status_text: 'Attempted' });
    expect(attempted.events![0]).toMatchObject({ description: 'Delivery attempted', stage: 'failed_attempt' });

    const returned = parsePhantom(order((shipment) => {
      shipment.stops.push({ type: 'RETURN', city: 'Burnaby', state: 'BC', completedAt: '1733250000',
        completionReason: null, tasks: [{ sequenceNumber: 20241203000080 }] });
    }), SAMPLE);
    expect(returned.events![0]).toMatchObject({ provider_code: 'RETURN', description: 'Returned', location: 'Burnaby, BC', stage: 'returned' });

    const moving = parsePhantom(order((shipment) => {
      shipment.status = 'IN_TRANSIT';
      shipment.stops[1]!.completedAt = null;
    }), SAMPLE);
    expect(moving).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update: '2024-12-03T17:26:04Z' });
    expect(moving.events!.map((event) => event.provider_code)).toEqual(['PICK_UP', 'ASSIGNED', 'CREATED']);

    const held = parsePhantom(order((shipment) => {
      shipment.status = 'ASSIGNED';
      shipment.holdStatus = 'ON_HOLD';
      shipment.stops.forEach((stop) => { stop.completedAt = null; });
    }), SAMPLE);
    expect(held).toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Your order is on hold.' });
  });

  it('orders stops by their route and keeps the newest milestone’s stage under a status the portal does not name', () => {
    // Two drop-offs completed in the same second keep the route's order: the later stop first.
    const twice = parsePhantom(order((shipment) => {
      shipment.status = 'PAUSED';
      shipment.stops.reverse();
      shipment.stops.push({ type: 'DROP_OFF', city: 'Richmond', state: 'BC', completedAt: '1733246859',
        completionReason: null, tasks: [{ sequenceNumber: 20241203000090 }] });
    }), SAMPLE);
    expect(twice).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', provider_code: 'PAUSED' });
    expect(twice.events!.slice(0, 2).map((event) => event.location)).toEqual(['Richmond, BC', 'Vancouver, BC']);
    expect(phantomShipmentStage('PAUSED', '', 'NONE')).toBeNull();
    expect(phantomShipmentStage('DELETED', '', 'ON_HOLD')).toEqual({ stage: 'exception', text: 'This Order is No Longer Active' });
    expect(phantomShipmentStage('COMPLETED', 'PARTIAL_COMPLETED', 'NONE')).toEqual({ stage: 'delivered', text: 'Delivered' });
  });

  it('reads an empty answer as not found, and an order of another number or a changed reply otherwise', async () => {
    expect(() => parsePhantom(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parsePhantom(fixture('delivered'), '445008')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePhantom({ errors: [{ message: 'Internal server error' }], data: null }, SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePhantom({ errors: [{ message: 'Too many requests' }] }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parsePhantom({ data: {} }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePhantom(order((shipment) => { shipment.createdAt = 1733186702; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePhantom(order((shipment) => { shipment.stops[0]!.type = 'LUNCH'; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePhantom(order((shipment) => { shipment.status = null; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a refusal, a rate limit, a moved endpoint and a browser check apart from a missing order', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>().mockResolvedValue(response)).track({ number: SAMPLE });
    await expect(answer(reply('<html>Attention Required! | Cloudflare</html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('{}', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 301, headers: { Location: 'https://courie.ai/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(answer(reply('{}', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(answer(reply('<html><head><title>Just a moment...</title></head></html>'))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('<html>maintenance</html>'))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('retries once when the first request does not reach Courie', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends only letters and digits the portal accepts', () => {
    expect(normalizePhantomNumber(' 445-009 ')).toBe(SAMPLE);
    for (const bad of ['4450', 'ABCDEF', '445009!', '1'.repeat(21), '']) {
      expect(() => normalizePhantomNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers each milestone statuses.json records by its code and label', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'phantom-couriers', providerCode: code, description: wording }), wording)
        .toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'phantom-couriers', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'phantom-couriers', providerCode: 'PICK_UP', description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});
