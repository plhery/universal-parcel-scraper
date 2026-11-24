import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BOXC_LOOKUP } from './adapter.js';
import { normalizeBoxcNumber, parseBoxc } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The two public samples in numbers.json, and an invented number the tracker does not know.
const DELIVERED_SAMPLE = '4006318880257783';
const EN_ROUTE_SAMPLE = 'LB095118387LT';
const OTHER = 'BOXC00000000999';
// The example label number of BoxC's API documentation (docs.boxc.com), a USPS package identifier.
const USPS_EXAMPLE = '9261290185965500000103';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const EN_ROUTE = fixture('en-route');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A synthetic shipment in the documented shape, with a delivery's place, postcode and coordinates.
const shipment = (fields: Record<string, unknown> = {}) => ({
  carrier: 'USPS', created: '2024-05-19T08:00:00+00:00', destination: { city: 'SYNTHETIC TOWN', country: 'US', port: 'JFK', province: 'NY' },
  entry_point: 'TEST01', events: [
    { carrier: 'USPS', city: 'Brooklyn', code: 200, country: 'US', description: 'DELIVERED', latitude: 40.69, longitude: -73.99,
      postal_code: '11201', province: 'NY', time: '2024-05-26 14:02:10' },
    { carrier: 'USPS', city: 'Brooklyn', code: 198, country: 'US', description: 'OUT FOR DELIVERY', latitude: null, longitude: null,
      postal_code: '11201', province: 'NY', time: '2024-05-26 07:11:45' },
    { carrier: 'BoxC', city: 'Shenzhen', code: 105, country: 'CN', description: 'SHIPMENT ACCEPTANCE', latitude: null, longitude: null,
      postal_code: null, province: null, time: '2024-05-20T10:05:08+08:00' },
  ],
  has_images: true, images: { pod: ['https://images.example/pod.jpg'], scans: [] }, order_number: 'SYNTHETIC-1', service: 'BoxC Parcel',
  shipment_id: 10002312, status: 'Delivered', tracking_number: USPS_EXAMPLE, ...fields,
});

describe('BoxC numbers', () => {
  it('takes 8 to 40 letters and digits with at least one digit, in capitals, as the tracking page does', () => {
    expect(normalizeBoxcNumber(` ${EN_ROUTE_SAMPLE.toLowerCase().slice(0, 2)} ${EN_ROUTE_SAMPLE.slice(2)} `)).toBe(EN_ROUTE_SAMPLE);
    expect(normalizeBoxcNumber(DELIVERED_SAMPLE)).toBe(DELIVERED_SAMPLE);
    for (const other of ['', '1234567', 'ABCDEFGHIJ', `${EN_ROUTE_SAMPLE};${DELIVERED_SAMPLE}`, 'LB/095118387LT', `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizeBoxcNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('BoxC tracking adapter', () => {
  it('posts the number to the lookup the tracking page posts it to', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: DELIVERED_SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(BOXC_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(JSON.parse(String(init.body))).toEqual({ trackingNumber: DELIVERED_SAMPLE });
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(carrier(fetcher)).toMatchObject({ id: 'boxc', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s not-found answer as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND, { status: 404 }))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"message":"Unauthorized"}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    // The tracker's other refusals leave the answer open, and its throttle is a rate limit.
    expect(await answer(() => json('{"success":false,"apiStatus":500,"data":"Internal error"}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"success":false,"apiStatus":404,"data":"Route not found"}'))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"success":false,"apiStatus":400,"message":"Bad request"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"success":false,"apiStatus":429,"data":"Too many requests"}'))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"message":"Not Found"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"message":"Not Found"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>404 Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://boxc.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    // The site answers an unknown path with its tracking app's page.
    expect(await answer(() => html('<!doctype html><html><body><div id="root"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{"success":true}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('BoxC replies', () => {
  it('reads the delivered sample: its status alone, with the service and the destination country', () => {
    expect(parseBoxc(JSON.parse(DELIVERED), DELIVERED_SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivered',
      last_update: null, expected_delivery: null, service_name: 'BoxC Parcel', destination_country: 'CA', summary_only: true, events: [],
    });
  });

  it('reads the en-route sample, whose final-mile carrier the catalog cannot follow under that number', () => {
    expect(parseBoxc(JSON.parse(EN_ROUTE), EN_ROUTE_SAMPLE.toLowerCase())).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'En Route',
      last_update: null, expected_delivery: null, service_name: 'BoxC Parcel', destination_country: 'ES', summary_only: true, events: [],
    });
  });

  it('reads the documented events, newest first, on the scan’s wall clock or with its stated offset', () => {
    expect(parseBoxc(shipment(), USPS_EXAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'DELIVERED',
      last_update: null, last_update_local: '2024-05-26T14:02:10', expected_delivery: null, service_name: 'BoxC Parcel',
      destination_country: 'US', delivery_carrier: 'usps',
      events: [
        { local_time: '2024-05-26T14:02:10', description: 'DELIVERED', location: 'Brooklyn, NY, US', provider_code: '200', stage: 'delivered',
          stage_source: 'carrier_map' },
        { local_time: '2024-05-26T07:11:45', description: 'OUT FOR DELIVERY', location: 'Brooklyn, NY, US', provider_code: '198',
          stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2024-05-20T10:05:08+08:00', description: 'SHIPMENT ACCEPTANCE', location: 'Shenzhen, CN', provider_code: '105',
          stage: 'accepted', stage_source: 'carrier_map' },
      ],
    });
  });

  it('never reads the destination’s town, the postcode or coordinates of a scan, the order number or the images', () => {
    const answer = JSON.stringify(parseBoxc(shipment(), USPS_EXAMPLE));
    for (const hidden of ['SYNTHETIC', '11201', '40.69', 'images.example', '10002312', 'JFK', 'TEST01']) expect(answer).not.toContain(hidden);
  });

  it('keeps an event the map does not know visible, and the status stands in when no event has a stage', () => {
    const unknown = parseBoxc(shipment({ status: 'En Route', events: [{ code: 999, description: 'Parked', time: '2024-05-21 09:00:00' }] }), USPS_EXAMPLE);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Parked' });
    expect(unknown.events).toEqual([{ local_time: '2024-05-21T09:00:00', description: 'Parked', provider_code: '999' }]);
    // An event without a code is staged by its whole wording.
    expect(parseBoxc(shipment({ events: [{ description: 'CUSTOMS RELEASE', time: '2024-05-22 09:00' }] }), USPS_EXAMPLE).events)
      .toEqual([{ local_time: '2024-05-22T09:00:00', description: 'CUSTOMS RELEASE', stage: 'in_transit', stage_source: 'carrier_map' }]);
    expect(parseBoxc(shipment({ status: 'Rerouted', events: [] }), USPS_EXAMPLE))
      .toMatchObject({ status: 'unknown', last_status_text: 'Rerouted', summary_only: true, events: [] });
  });

  it('names the final-mile carrier only when the catalog knows it and its rules fit the number', () => {
    const partner = (name: unknown, number = USPS_EXAMPLE) => parseBoxc(shipment({ carrier: name, tracking_number: number }), number).delivery_carrier;
    expect(partner('USPS')).toBe('usps');
    expect(partner('DHL eCommerce')).toBe('dhl-ecommerce');
    for (const other of ['DHLeC', 'Sagawa', 'BoxC', '', null]) expect(partner(other), String(other)).toBeUndefined();
    expect(partner('USPS', EN_ROUTE_SAMPLE)).toBeUndefined();
    expect(partner('PostPlus', EN_ROUTE_SAMPLE)).toBeUndefined();
    // A shipment listed without a status or events names it too.
    expect(() => parseBoxc(shipment({ status: '', events: [] }), USPS_EXAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed', deliveryCarrier: 'usps' }));
  });

  it('refuses an answer for another shipment', () => {
    expect(() => parseBoxc(JSON.parse(DELIVERED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, [], 'x', {}, shipment({ tracking_number: 7 }), shipment({ status: null }), shipment({ events: {} }),
      shipment({ destination: 'US' }), shipment({ service: 7 }), shipment({ carrier: {} }), shipment({ events: [null] }),
      shipment({ events: [{ code: 200, time: '2024-05-26 14:02:10' }] }), shipment({ events: [{ code: '2x', description: 'DELIVERED', time: '2024-05-26 14:02:10' }] }),
      shipment({ events: [{ code: 200, description: 'DELIVERED', time: '26/05/2024 14:02' }] }),
      shipment({ events: [{ code: 200, description: 'DELIVERED', time: '2024-02-30 14:02:10' }] }),
      shipment({ events: [{ code: 200, description: 'DELIVERED' }] }), shipment({ events: [{ code: 200, description: 'DELIVERED', time: '2024-05-26 14:02:10', city: 7 }] }),
      shipment({ events: Array.from({ length: 301 }, () => ({ code: 150, description: 'EN ROUTE', time: '2024-05-26 14:02:10' })) })]) {
      expect(() => parseBoxc(changed, USPS_EXAMPLE), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('BoxC statuses', () => {
  it('maps every status and documented event code, and a relayed event by its whole wording', () => {
    for (const entry of statuses.entries) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), `${code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'boxc', providerCode: code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('999', 'delivered')).toBeUndefined();
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});
