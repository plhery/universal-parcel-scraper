import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { carrierScan } from '../../providers/shared/scans.js';
import {
  PaackTracker,
  normalizePaackPostcode,
  normalizePaackTrackingNumber,
  paackTrackingUrl,
  parsePaackTrackingHtml,
  parsePaackTrackingResponse,
} from './adapter.js';
import { classifyPaackEvent, paackScan, statusKey } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Paack publishes this synthetic exchange order in its official Postman
// examples: https://www.postman.com/paacklogistics/paack-apis/folder/1uuw6iw/orders-api
// The response below is a fully synthetic provider-shaped fixture.
const OFFICIAL_EXAMPLE_NUMBER = 'EXCHANGE000001D';
const OFFICIAL_EXAMPLE_POSTCODE = '08006';

function json(relativePath: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));
}

const carrier = json('./carrier.json') as { capabilities: readonly string[] };

function successRoute(overrides: Record<string, unknown> = {}): unknown {
  return { ...json('./fixtures/delivered-order.json') as Record<string, unknown>, ...overrides };
}

// Paack finds an order by its label barcode too, and then echoes the
// retailer's own reference in external_id instead of the number typed.
// Synthetic barcode; the fixture's delivery postcode is LABEL_POSTCODE.
const LABEL_BARCODE = '100000000000000001';
const LABEL_POSTCODE = '75001';

function labelRoute(orderOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const route = json('./fixtures/label-barcode-order.json') as Record<string, unknown>;
  return { ...route, orderTrackData: { ...route.orderTrackData as object, ...orderOverrides } };
}

function trackingPage(route: unknown = successRoute()): string {
  const context = {
    state: {
      loaderData: {
        root: { ENV: { PUBLIC_CONFIG: 'not retained' } },
        'routes/tracking.order': route,
      },
    },
  };
  return `<!doctype html><html><body><main>Tracking</main>
    <script>window.__remixContext = ${JSON.stringify(context)};</script>
  </body></html>`;
}

function producedCapabilities(...results: CarrierResult[]): Set<string> {
  const produced = new Set<string>();
  for (const result of results) {
    const events = result.events ?? [];
    if (events.length > 0) produced.add('history');
    if (events.some((event) => event.location)) produced.add('location');
    if (events.some((event) => event.provider_code)) produced.add('provider_code');
    if (result.expected_delivery) produced.add('eta');
    if (result.expected_delivery_from) produced.add('eta_window');
    if (result.sender_name) produced.add('sender_name');
    if (result.pickup_point) produced.add('pickup_point');
    if (result.weight_kg != null) produced.add('weight');
    if (result.dimensions_text) produced.add('dimensions');
    if (result.delivered_at) produced.add('delivered_at');
  }
  return produced;
}

afterEach(() => vi.restoreAllMocks());

describe('Paack anonymous tracking request', () => {
  it('validates the order and 3- to 10-character destination postcode independently', () => {
    expect(normalizePaackTrackingNumber(` ${OFFICIAL_EXAMPLE_NUMBER.toLowerCase()} `))
      .toBe(OFFICIAL_EXAMPLE_NUMBER);
    expect(normalizePaackPostcode(' 75 001 ')).toBe('75001');
    expect(normalizePaackPostcode('4445-027')).toBe('4445-027');
    expect(normalizePaackPostcode('1201')).toBe('1201');
    expect(normalizePaackPostcode('sw1a 1aa')).toBe('SW1A1AA');

    for (const value of [
      'ABC',
      'ABCD',
      'ORDER-NUMBER',
      'ORDER_PRIVATE',
      'ORDER?admin=true',
      'ORDER/PRIVATE',
      'ORDÉR',
      '1'.repeat(41),
    ]) {
      expect(() => normalizePaackTrackingNumber(value)).toThrow('4 to 40 ASCII');
    }
    for (const value of [
      '12',
      '12 - 345',
      '75001&admin=true',
      'ABCDEFGHIJ',
      '75_001',
      '75001É',
    ]) {
      expect(() => normalizePaackPostcode(value)).toThrow('3- to 10-character');
    }
  });

  it('builds the official two-factor query without allowing parameter injection', () => {
    const url = new URL(paackTrackingUrl(
      OFFICIAL_EXAMPLE_NUMBER,
      OFFICIAL_EXAMPLE_POSTCODE,
    ));
    expect(url.origin).toBe('https://mydeliveries.paack.app');
    expect(url.pathname).toBe('/tracking/order');
    expect(url.searchParams.get('tracking_number')).toBe(OFFICIAL_EXAMPLE_NUMBER);
    expect(url.searchParams.get('postal_code')).toBe(OFFICIAL_EXAMPLE_POSTCODE);
    expect([...url.searchParams]).toHaveLength(2);
  });
});

describe('Paack status vocabulary', () => {
  it('keys on the stable identifiers and leaves unknown ones unmapped', () => {
    expect(statusKey('returnedToSender')).toBe('returnedtosender');
    expect(classifyPaackEvent({ id: 'pudoAssignedHeader', label: 'pudoAssignedHeader' }))
      .toMatchObject({ stage: 'in_transit' });
    expect(classifyPaackEvent({ id: 'brandNewState', label: 'brandNewState' })).toEqual({
      status: 'unknown',
      stage: 'in_transit',
      description: 'Shipment update',
    });
  });

  it('files every recorded status under its stage', () => {
    for (const entry of statuses.entries) {
      if (entry.wording !== undefined) expect(paackScan(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      else expect(classifyPaackEvent({ label: entry.code ?? '' }).stage, entry.code).toBe(entry.stage);
    }
  });

  it.each([
    ['SM001', 'manifested', 'pending', 'registered', 'Shipment registered'],
    ['SM002', 'scannedAtOrigin', 'in_transit', 'accepted', 'Shipment accepted'],
    ['SP002', 'inDelivery', 'out_for_delivery', 'out_for_delivery', 'Out for delivery'],
    ['SP003', 'delivered', 'delivered', 'delivered', 'Delivered'],
  ] as const)('maps the live timeline step %s (%s)', (id, label, status, stage, description) => {
    expect(classifyPaackEvent({ id, label })).toEqual({ status, stage, description });
  });

  it('gives the labels an aggregator relays the stage and wording of the direct lookup', () => {
    // Paack's English page labels for manifested, scannedAtOrigin, inDelivery and delivered.
    expect(carrierScan('paack', 'Order details received'))
      .toEqual({ stage: 'registered', wording: 'Shipment registered' });
    expect(carrierScan('paack', 'In Paack’s distribution centre'))
      .toEqual({ stage: 'accepted', wording: 'Shipment accepted' });
    expect(paackScan("In Paack's distribution centre")).toEqual(paackScan('In Paack’s distribution centre'));
    expect(paackScan('Out for delivery')).toEqual({ stage: 'out_for_delivery', wording: 'Out for delivery' });
    expect(paackScan('Delivered')).toEqual({ stage: 'delivered', wording: 'Delivered' });
    // Exact labels only: free text is left to the shared wording rules.
    expect(paackScan('Order details received by the depot')).toBeUndefined();
    expect(paackScan('Not delivered')).toBeUndefined();
  });
});

describe('Paack response normalization', () => {
  it('parses a provider-shaped fixture while excluding order and event variables', () => {
    const result = parsePaackTrackingResponse(successRoute(), OFFICIAL_EXAMPLE_POSTCODE);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2024-07-28T13:02:00.000Z',
      expected_delivery: null,
      timezone: 'Europe/Paris',
    });
    expect(result.events).toEqual([
      {
        time: '2024-07-28T13:02:00.000Z',
        description: 'Delivered',
        stage: 'delivered',
      },
      {
        time: '2024-07-28T10:05:00.000Z',
        description: 'Out for delivery',
        stage: 'out_for_delivery',
      },
      {
        time: '2024-07-27T16:30:00.000Z',
        description: 'Shipment exception',
        stage: 'exception',
      },
    ]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      'PRIVATE INTERNAL ORDER',
      'PRIVATE RETAILER',
      'PRIVATE RECIPIENT',
      'private@example.test',
      'PRIVATE PHONE',
      'PRIVATE STREET',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('extracts the Remix loader response from provider HTML', () => {
    expect(parsePaackTrackingHtml(trackingPage(), OFFICIAL_EXAMPLE_POSTCODE))
      .toMatchObject({ status: 'delivered', last_status_text: 'Delivered' });
  });

  it('retains an expected date only for a non-terminal shipment', () => {
    const result = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'driver-assigned',
        label: 'inProgress',
        timestamp: '2024-07-28T12:05:00+02:00',
        timeline: true,
      }],
      activeEvent: {
        id: 'driver-assigned',
        label: 'inProgress',
        time: '2024-07-28T12:05:00+02:00',
      },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      expected_delivery: '2024-07-28',
    });
  });

  it('produces every capability carrier.json declares', () => {
    const delivered = parsePaackTrackingResponse(successRoute(), OFFICIAL_EXAMPLE_POSTCODE);
    const inFlight = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'driver-assigned',
        label: 'inProgress',
        timestamp: '2024-07-28T12:05:00+02:00',
        timeline: true,
      }],
      activeEvent: { id: 'driver-assigned', label: 'inProgress' },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    const produced = producedCapabilities(delivered, inFlight);
    expect(carrier.capabilities.length).toBeGreaterThan(0);
    for (const capability of carrier.capabilities) expect([...produced]).toContain(capability);
  });

  it('classifies not-delivered wording before the delivered substring', () => {
    const result = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'not-delivered',
        label: 'notDelivered',
        timestamp: '2024-07-28T15:02:00+02:00',
        timeline: true,
      }],
      activeEvent: {
        id: 'not-delivered',
        label: 'notDelivered',
      },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(result).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });
  });

  it('maps the official Paack return and recipient-absent identifiers', () => {
    const returned = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'returnedToSender',
        label: 'returnedToSender',
        timestamp: '2024-07-28T15:02:00+02:00',
        timeline: true,
      }],
      activeEvent: {
        id: 'returnedToSender',
        label: 'returnedToSender',
      },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(returned).toMatchObject({
      status: 'exception',
      events: [{ stage: 'returned' }],
    });

    const absent = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'absent',
        label: 'absent',
        timestamp: '2024-07-28T15:02:00+02:00',
        timeline: true,
      }],
      activeEvent: {
        id: 'absent',
        label: 'absent',
      },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(absent).toMatchObject({
      status: 'exception',
      events: [{ stage: 'failed_attempt' }],
    });
  });

  it.each(['returnToSenderScheduled', 'returnAbsent', 'returnOther'])(
    'keeps the non-final %s return state active',
    (identifier) => {
      const result = parsePaackTrackingResponse(successRoute({
        eventList: [{
          id: identifier,
          label: identifier,
          timestamp: '2024-07-28T15:02:00+02:00',
          timeline: true,
        }],
        activeEvent: { id: identifier, label: identifier },
      }), OFFICIAL_EXAMPLE_POSTCODE);
      expect(result).toMatchObject({
        status: 'exception',
        events: [{ stage: 'failed_attempt' }],
      });
    },
  );

  it('uses the official active event when it is newer than the timeline', () => {
    const result = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: 'received-at-hub',
        label: 'receivedAtHub',
        timestamp: '2024-07-28T12:05:00+02:00',
        timeline: true,
      }],
      activeEvent: {
        id: 'returnedToSender',
        label: 'returnedToSender',
      },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(result).toMatchObject({
      status: 'exception',
      last_status_text: 'Shipment returned',
      events: [{ stage: 'in_transit' }],
    });
  });

  it.each([
    ['scannedAtOriginHeader', 'in_transit', 'accepted'],
    ['orderReactivated', 'pending', 'registered'],
    ['appointmentBroughtForward', 'pending', 'registered'],
    ['appointmentRescheduled', 'pending', 'registered'],
    ['pudoAssignedHeader', 'in_transit', 'in_transit'],
    ['integrationError', 'exception', 'exception'],
  ] as const)('maps the official active label %s', (label, status, stage) => {
    const result = parsePaackTrackingResponse(successRoute({
      eventList: [{
        id: label,
        label,
        timestamp: '2024-07-28T15:02:00+02:00',
        timeline: true,
      }],
      activeEvent: { id: label, label },
    }), OFFICIAL_EXAMPLE_POSTCODE);
    expect(result).toMatchObject({
      status,
      events: [{ stage }],
    });
    expect(result.last_status_text).toBeTruthy();
  });

  it('rejects an order for another postcode and malformed data, and maps explicit not-found', () => {
    const otherPostcode = successRoute({
      orderTrackData: { external_id: OFFICIAL_EXAMPLE_NUMBER, delivery_address: { post_code: '08021' } },
    });
    expect(() => parsePaackTrackingResponse(otherPostcode, OFFICIAL_EXAMPLE_POSTCODE))
      .toThrow(SchemaError);
    expect(() => parsePaackTrackingResponse(otherPostcode, OFFICIAL_EXAMPLE_POSTCODE))
      .toThrow('different shipment');
    expect(() => parsePaackTrackingResponse({ orderTrackData: {
      external_id: OFFICIAL_EXAMPLE_NUMBER,
    } }, OFFICIAL_EXAMPLE_POSTCODE)).toThrow('incomplete tracking details');
    expect(() => parsePaackTrackingHtml(
      '<main>Order not found. Incorrect order number or postal code.</main>',
      OFFICIAL_EXAMPLE_POSTCODE,
    )).toThrow(NotFoundError);
  });

  it('reports its own parse failures without an HTTP status', () => {
    for (const payload of [
      successRoute({ orderTrackData: { delivery_address: { post_code: '08021' } } }),
      { orderTrackData: {} },
      { state: {} },
    ]) {
      let failure: unknown;
      try {
        parsePaackTrackingResponse(payload, OFFICIAL_EXAMPLE_POSTCODE);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ kind: 'schema' });
      // Consumers read the deepest status in the cause chain as the upstream answer.
      for (let current = failure; current instanceof Error; current = current.cause) {
        expect((current as Error & { status?: unknown }).status).toBeUndefined();
      }
    }
  });
});

describe('Paack label barcode lookup', () => {
  it('accepts the order the number and postcode pair resolved to', () => {
    const result = parsePaackTrackingResponse(labelRoute(), LABEL_POSTCODE);
    expect(result).toEqual({
      status: 'in_transit',
      current_stage: 'accepted',
      last_status_text: 'Shipment accepted',
      last_update: '2024-07-27T16:38:19.000Z',
      expected_delivery: '2024-07-28',
      timezone: 'Europe/Paris',
      // The steps still to come carry no timestamp and are not history.
      events: [
        { time: '2024-07-27T16:38:19.000Z', description: 'Shipment accepted', stage: 'accepted' },
        { time: '2024-07-27T10:50:30.000Z', description: 'Shipment registered', stage: 'registered' },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['PRIVATE', LABEL_POSTCODE]) expect(serialized).not.toContain(privateValue);
  });

  it('compares the echoed delivery postcode by its letters and digits', () => {
    expect(parsePaackTrackingResponse(labelRoute({
      delivery_address: { country: 'GB', post_code: 'SW1A 1AA' },
    }), 'sw1a1aa')).toMatchObject({ current_stage: 'accepted' });
    expect(parsePaackTrackingResponse(labelRoute({
      delivery_address: { country: 'PT', post_code: '4445027' },
    }), '4445-027')).toMatchObject({ current_stage: 'accepted' });
    // Without an echoed postcode the lookup pair alone identifies the order.
    expect(parsePaackTrackingResponse(labelRoute({ delivery_address: null }), LABEL_POSTCODE))
      .toMatchObject({ current_stage: 'accepted' });
    expect(() => parsePaackTrackingResponse(labelRoute({
      delivery_address: { country: 'FR', post_code: '75002' },
    }), LABEL_POSTCODE)).toThrow(expect.objectContaining({
      kind: 'schema',
      message: 'Paack returned a different shipment',
    }));
  });
});

describe('Paack tracker', () => {
  it('uses a bounded no-redirect request with both recipient inputs', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(trackingPage()));

    await expect(new PaackTracker({ timeoutMs: 1_000 }).fetch(
      OFFICIAL_EXAMPLE_NUMBER,
      OFFICIAL_EXAMPLE_POSTCODE,
    )).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls[0]?.[0]).toBe(paackTrackingUrl(
      OFFICIAL_EXAMPLE_NUMBER,
      OFFICIAL_EXAMPLE_POSTCODE,
    ));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      cache: 'no-store',
      redirect: 'manual',
    });
  });

  it('maps the official wrong-number redirect and 404 to a clean not-found error', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: '/tracking?tracking_number=00000000&postal_code=75001&err=true' },
    }));
    await expect(new PaackTracker().fetch('00000000', '75001')).rejects.toMatchObject({
      name: 'NotFoundError',
      kind: 'not_found',
      provider: 'Paack',
      message: 'Paack could not locate the shipment',
      status: 404,
    });

    fetcher.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(new PaackTracker().fetch('00000000', '75001'))
      .rejects.toMatchObject({ status: 404 });
  });

  const redirect = (location: string | null) => new Response(null, {
    status: 302,
    headers: location === null ? {} : { Location: location },
  });
  const movedLookup = `https://paack.co/shipments/tracking/order?tracking_number=${LABEL_BARCODE}&postal_code=${LABEL_POSTCODE}`;

  it('follows the same lookup once to the host the page is moving to', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect(movedLookup))
      .mockResolvedValueOnce(new Response(trackingPage(labelRoute())));

    await expect(new PaackTracker().fetch(LABEL_BARCODE, LABEL_POSTCODE))
      .resolves.toMatchObject({ current_stage: 'accepted', events: [{ stage: 'accepted' }, { stage: 'registered' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(movedLookup);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('maps the wrong-pair redirect of the new host to not-found', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect(movedLookup))
      .mockResolvedValueOnce(redirect(`/tracking?postal_code=${LABEL_POSTCODE}&tracking_number=${LABEL_BARCODE}&err=true`));
    await expect(new PaackTracker().fetch(LABEL_BARCODE, LABEL_POSTCODE))
      .rejects.toMatchObject({ name: 'NotFoundError', kind: 'not_found' });
  });

  it.each([
    ['no location', null],
    ['the form without err', `https://mydeliveries.paack.app/tracking?tracking_number=${LABEL_BARCODE}&postal_code=${LABEL_POSTCODE}`],
    ['another host', `https://example.test/tracking/order?tracking_number=${LABEL_BARCODE}&postal_code=${LABEL_POSTCODE}&err=true`],
    ['plain HTTP', movedLookup.replace('https:', 'http:')],
    ['another number', movedLookup.replace(LABEL_BARCODE, '100000000000000002')],
    ['another postcode', movedLookup.replace(`postal_code=${LABEL_POSTCODE}`, 'postal_code=75002')],
  ])('does not read a redirect to %s as a missing parcel', async (_, location) => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(redirect(location));
    await expect(new PaackTracker().fetch(LABEL_BARCODE, LABEL_POSTCODE))
      .rejects.toMatchObject({ name: 'IndeterminateError', kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops after one redirect', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(redirect(movedLookup))
      .mockResolvedValueOnce(redirect(movedLookup));
    await expect(new PaackTracker().fetch(LABEL_BARCODE, LABEL_POSTCODE))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
