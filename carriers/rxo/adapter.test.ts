import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, rxoLookupUrl } from './adapter.js';
import { normalizeRxoNumber, parseRxo } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The three public samples in numbers.json, the first one's sales order id, and an invented number.
const DELIVERED_SAMPLE = 'RXONC70OKLNWA14J26';
const DELIVERED_ORDER = '00000H2S4MC58000002000';
const INSTALLED_SAMPLE = 'RXONC70OSO5GWB6J26';
const RETURNED_SAMPLE = 'RXONC70OPDXJNKNI26';
const OTHER = 'RXONC70OZZZZZZZZ26';
// The synthetic number the detection tests open an RXO link with.
const SYNTHETIC = 'RXOL100000000017';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const INSTALLED = fixture('installed');
const RETURNED = fixture('returned');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// A synthetic appointment in the reply's shape: a delivery on its way, with its window.
const appointment = (fields: Record<string, unknown> = {}) => ({
  trackingNumber: SYNTHETIC, salesOrderId: '00000SYNTHETIC0000000', salesOrderCategoryId: 1, currentStatus: 'SH', status: 'SH',
  billTo: { name: 'Synthetic Retailer' }, referenceId: 'SYNTHETIC-REF', latitude: 40.7, longitude: -74,
  deliveryServiceWindowStartTime: '11/20/2026 08:00:00 -05:00', deliveryServiceWindowEndTime: '11/20/2026 12:00:00 -05:00',
  orderScheduledDate: '2026-11-20T00:00:00', orderBookedDate: '2026-11-10T09:00:00',
  events: [
    { city: 'NEWARK, NJ, US', name: 'Items arrived at the pickup location', eventDate: '2026-11-18T07:01:23' },
    { city: 'NEWARK, NJ, US', name: 'Order Created', eventDate: '2026-11-10T09:00:36' },
  ],
  exceptions: [], items: [{ sku: 'SYNTHETIC-SKU', quantity: 1, exceptions: [] }],
  ...fields,
});
const order = (...appointments: Record<string, unknown>[]) => [appointments];

describe('RXO numbers', () => {
  it('takes 8 to 30 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeRxoNumber(` ${DELIVERED_SAMPLE.toLowerCase()} `)).toBe(DELIVERED_SAMPLE);
    expect(normalizeRxoNumber(DELIVERED_ORDER)).toBe(DELIVERED_ORDER);
    for (const other of ['', 'RXO1234', 'ABCDEFGHIJKL', `${DELIVERED_SAMPLE};1`, 'RXO/100000000017', `RXO${'1'.repeat(28)}`]) {
      expect(() => normalizeRxoNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('RXO tracking adapter', () => {
  it('asks the lookup the tracking page asks, across every retailer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(carrier(fetcher).track({ number: DELIVERED_SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`https://clm.rxo.com/trackapi/orders/trackbillto/${DELIVERED_SAMPLE}?billTo=0`);
    expect(rxoLookupUrl(DELIVERED_SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('origin')).toBe('https://track.rxo.com');
    // The lookup refuses fetch's default `Accept-Language: *` as an unsupported culture.
    expect(new Headers(init.headers).get('accept-language')).toBe('en-US');
    expect(carrier(fetcher)).toMatchObject({ id: 'rxo', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the lookup’s empty list as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, refusals, redirects and changed replies apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"message":"Unauthorized"}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('[]', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://rxo.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"message":"error"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    // The tracker's own page in place of the lookup's JSON.
    expect(await answer(() => html('<!doctype html><html><body><app-root></app-root></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('{}'))).toMatchObject({ kind: 'schema' });
  });
});

describe('RXO replies', () => {
  it('reads the delivered sample: a stop rescheduled en route, then the delivery', () => {
    const result = parseRxo(JSON.parse(DELIVERED), DELIVERED_SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Delivery completed',
      last_update: null, last_update_local: '2026-10-17T13:23:24', expected_delivery: null, sender_name: 'Samsung',
    });
    expect(result.events!).toHaveLength(12);
    expect(result.events![0]).toEqual({ local_time: '2026-10-17T13:23:24', description: 'Delivery completed', location: 'WHITE PLAINS, MD, US',
      stage: 'delivered', stage_source: 'carrier_map' });
    // The first appointment closed with "Delivery completed", but its stop was not performed.
    expect(result.events![6]).toEqual({
      local_time: '2026-10-16T06:45:26', description: 'Cannot Perform Stop : Stop not performed due to the consignee rescheduling enroute.',
      original_description: 'Delivery completed', location: 'WHITE PLAINS, MD, US', provider_code: 'CANT-PERFORM-STOP',
      stage: 'failed_attempt', stage_source: 'carrier_map',
    });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-10-04T14:25:10', description: 'Order Created', stage: 'registered' });
    // The order's sales order id opens the same order.
    expect(parseRxo(JSON.parse(DELIVERED), DELIVERED_ORDER)).toEqual(result);
  });

  it('reads the installed sample: installation visits keep the delivery’s stage', () => {
    const result = parseRxo(JSON.parse(INSTALLED), INSTALLED_SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Service completed', last_update_local: '2026-10-22T09:14:27',
      expected_delivery: null, sender_name: 'Samsung Wayfair',
    });
    expect(result.events!).toHaveLength(20);
    expect(result.events!.slice(0, 4).map((event) => [event.description, event.stage])).toEqual([
      ['Service completed', undefined], ['Driver has arrived at the service location', undefined],
      ['Driver is on the route for the service', undefined], ['Delivery completed', 'delivered'],
    ]);
    // A visit that was not performed keeps no code and no stage; the service's own "Order Created" is dropped.
    expect(result.events!.find((event) => event.original_description === 'Service completed')).toEqual({
      local_time: '2026-10-15T12:42:47', description: 'Cannot Perform Stop : Stop not performed due to the consignee rescheduling enroute.',
      original_description: 'Service completed', location: 'ATLANTA, GA, US',
    });
    expect(result.events!.filter((event) => event.description === 'Order Created')).toHaveLength(2);
  });

  it('reads the returned sample: a return pickup brought back to the facility', () => {
    const result = parseRxo(JSON.parse(RETURNED), RETURNED_SAMPLE);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map', last_status_text: 'Return completed',
      last_update_local: '2026-10-08T22:57:38', expected_delivery: null, sender_name: 'Amazon',
    });
    expect(result.events!).toHaveLength(9);
    expect(result.events![7]).toMatchObject({ original_description: 'Return completed', provider_code: 'CANT-PERFORM-STOP', stage: 'failed_attempt' });
  });

  it('reads an open appointment’s window as the estimate, and the scheduled day without one', () => {
    expect(parseRxo(order(appointment()), SYNTHETIC)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Items arrived at the pickup location',
      last_update: null, last_update_local: '2026-11-18T07:01:23', expected_delivery_from: '2026-11-20T08:00:00-05:00',
      expected_delivery: '2026-11-20T12:00:00-05:00', sender_name: 'Synthetic Retailer',
      events: [
        { local_time: '2026-11-18T07:01:23', description: 'Items arrived at the pickup location', location: 'NEWARK, NJ, US', stage: 'in_transit',
          stage_source: 'carrier_map' },
        { local_time: '2026-11-10T09:00:36', description: 'Order Created', location: 'NEWARK, NJ, US', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    expect(parseRxo(order(appointment({ deliveryServiceWindowStartTime: '2026-11-20 08:00', deliveryServiceWindowEndTime: '2026-11-20 12:00' })), SYNTHETIC))
      .toMatchObject({ expected_delivery: '2026-11-20 08:00–12:00' });
    expect(parseRxo(order(appointment({ deliveryServiceWindowStartTime: null, deliveryServiceWindowEndTime: null })), SYNTHETIC))
      .toMatchObject({ expected_delivery: '2026-11-20' });
    expect(parseRxo(order(appointment({ currentStatus: 'DL' })), SYNTHETIC)).toMatchObject({ expected_delivery: null });
  });

  it('never reads coordinates, items or the retailer’s reference', () => {
    const answer = JSON.stringify(parseRxo(order(appointment()), SYNTHETIC));
    for (const hidden of ['40.7', 'SYNTHETIC-SKU', 'SYNTHETIC-REF', '00000SYNTHETIC']) expect(answer).not.toContain(hidden);
  });

  it('reads a stop whose every item was not handled as a failed attempt', () => {
    const notHandled = { exceptionTypeId: 2, exceptionCode: 'CANT-PU/DEL-ITEM', exceptionDetails: 'Cannot Pickup/Deliver Item : Damaged' };
    const closed = appointment({ currentStatus: 'DL', events: [
      { city: 'NEWARK, NJ, US', name: 'Delivery completed', eventDate: '2026-11-20T10:00:00' }, ...appointment().events as unknown[],
    ] });
    const items = (exceptions: unknown[][]) => exceptions.map((list, index) => ({ sku: `SKU${index}`, exceptions: list }));
    expect(parseRxo(order({ ...closed, items: items([[notHandled], [notHandled]]) }), SYNTHETIC)).toMatchObject({
      current_stage: 'failed_attempt', last_status_text: 'Cannot Pickup/Deliver Item : Damaged',
      events: [expect.objectContaining({ original_description: 'Delivery completed', provider_code: 'CANT-PU/DEL-ITEM', stage: 'failed_attempt' }),
        expect.anything(), expect.anything()],
    });
    // One item delivered: the stop was performed.
    expect(parseRxo(order({ ...closed, items: items([[notHandled], []]) }), SYNTHETIC)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads a cancelled order as an exception, and an order without events as listed', () => {
    expect(parseRxo(order(appointment({ currentStatus: 'CN' })), SYNTHETIC)).toMatchObject({
      status: 'exception', current_stage: 'exception', provider_code: 'CN', last_status_text: 'Cancelled', expected_delivery: null,
    });
    expect(() => parseRxo(order(appointment({ events: [] })), SYNTHETIC)).toThrow(expect.objectContaining({ name: 'NoHistoryError', kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses an answer for another order', () => {
    expect(() => parseRxo(JSON.parse(DELIVERED), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    for (const changed of [null, {}, 'x', [{}], [[]], [[null]], order(appointment({ trackingNumber: 7 })), order(appointment({ events: {} })),
      order(appointment({ events: [null] })), order(appointment({ events: [{ name: 'Order Created' }] })),
      order(appointment({ events: [{ name: 'Order Created', eventDate: '11/10/2026 09:00' }] })),
      order(appointment({ events: [{ name: 'Order Created', eventDate: '2026-02-30T09:00:00' }] })),
      order(appointment({ events: [{ eventDate: '2026-11-10T09:00:00' }] })), order(appointment({ events: [{ name: 7, eventDate: '2026-11-10T09:00:00' }] })),
      order(appointment({ events: Array.from({ length: 301 }, () => ({ name: 'Order Created', eventDate: '2026-11-10T09:00:00' })) }))]) {
      expect(() => parseRxo(changed, SYNTHETIC), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('RXO statuses', () => {
  it('maps every event wording whole and every exception and order status by its code', () => {
    for (const entry of statuses.entries) {
      const code = entry.code ?? null;
      expect(statusMap.stage(code, entry.wording.toLowerCase()), `${code} ${entry.wording}`).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'rxo', providerCode: code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMap.stage('XX', 'delivery completed')).toBeUndefined();
  });

  it('leaves installation visits without a stage on purpose', () => {
    for (const wording of ['Driver is on the route for the service', 'Driver has arrived at the service location', 'Service completed',
      'Cannot Perform Stop : Stop not performed due to the consignee rescheduling enroute.']) {
      expect(statusMapAnswer({ carrier: 'rxo', providerCode: null, description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
    }
  });
});
