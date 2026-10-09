import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupBudget } from '../../core/adapter/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import type { JsonObject } from '../../core/types.js';
import { parseSwissPostShipment, swissPostPickupPoint, SwissPostTracker } from './adapter.js';
import { EVENT_STAGE_BY_CODE, swissPostEventStage } from './status.js';

const WRONG_SWISS_POST_NUMBER = '989999999999999999';

interface ShipmentFixture {
  shipment: JsonObject;
  events: unknown[];
  translations: Record<string, string>;
}

const outForDelivery = (): ShipmentFixture => JSON.parse(
  readFileSync(new URL('./fixtures/out-for-delivery.json', import.meta.url), 'utf8'),
) as ShipmentFixture;
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function mockSearchResult(items: unknown): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(JSON.stringify({
      userIdentifier: 'unit-test-user',
    }), { headers: { 'x-csrf-token': 'unit-test-csrf' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'unit-test-hash' })))
    .mockResolvedValueOnce(new Response(JSON.stringify(items)));
}

afterEach(() => vi.restoreAllMocks());

describe('Swiss Post historical event codes', () => {
  it('retains the exact international barcode supplied by the carrier', () => {
    expect(parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED', internationalBarcode: '12345678901' }, []))
      .toMatchObject({ international_tracking_number: '12345678901' });
    expect(parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED', internationalBarcode: null }, []))
      .not.toHaveProperty('international_tracking_number');
  });

  it.each([
    ['100', 'Time at which your consignment was mailed', 'accepted'],
    ['500', 'Picked up at the sender', 'accepted'],
    ['501', 'Picked up at the client', 'accepted'],
    ['502', 'Picked up', 'accepted'],
    ['620', 'Consignment recorded by the foreign sender (data delivered)', 'registered'],
    ['803', 'Customs clearance process underway', 'customs'],
    ['804', 'Completion of customs clearance process', 'in_transit'],
    ['805', 'Completion of customs clearance process', 'in_transit'],
    ['818', 'Arrival in destination country', 'in_transit'],
    ['854', 'Your shipment will shortly be handed over to the Swiss Post', 'registered'],
    ['859', 'Your shipment will shortly be handed over to Swiss Post', 'registered'],
    ['910', 'Registered for collection', 'ready_for_pickup'],
    ['912', 'Time at which your consignment was mailed', 'accepted'],
    ['915', 'The consignment has left the border point', 'in_transit'],
    ['923', 'Delivery failed: Recipient unknown', 'failed_attempt'],
    ['926', 'Retention period was extended by recipient', 'ready_for_pickup'],
    ['934', 'Delivery failed: Shipment undeliverable', 'failed_attempt'],
    ['1001', 'Arrival at the collection/delivery point', 'in_transit'],
    ['1100', 'Arrival at the delivery point', 'in_transit'],
    ['1204', 'Consignment is being processed', 'in_transit'],
    ['1213', 'Sorted for delivery', 'in_transit'],
    ['1218', 'Sorted for delivery', 'in_transit'],
    ['3800', 'Delivered to the mailbox/letter box', 'delivered'],
    ['4020', 'Forwarding abroad', 'in_transit'],
  ])('classifies scan %s from its code for letters and parcels alike', (code, description, stage) => {
    expect(EVENT_STAGE_BY_CODE[code]).toBe(stage);
    for (const eventCode of [`LETTER.*.90.${code}`, `LETTER.*.93.${code}`, `PARCEL.*.2.${code}`]) {
      expect(swissPostEventStage(eventCode)).toBe(stage);
      const result = parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED' }, [
        { eventCode, timestamp: '2026-09-10T07:00:00+02:00', externalMetadata: { description } },
      ]);
      expect(result.current_stage).toBe(stage);
      expect(result.events?.[0]).toMatchObject({ description, stage });
    }
  });

  it('leaves unknown codes, enquiry and delay notes and recipient orders to the wording', () => {
    expect(swissPostEventStage('PARCEL.*.1.1003')).toBe(EVENT_STAGE_BY_CODE['1003']);
    expect(swissPostEventStage('PARCEL.*.1.9999')).toBeUndefined();
    expect(swissPostEventStage('LETTER.*.93.9112')).toBeUndefined();
    expect(swissPostEventStage('LETTER.*.90.1800')).toBeUndefined();
    expect(swissPostEventStage('PARCEL.*.1.9224')).toBeUndefined();
  });

  it('never takes a stage from a revoked scan', () => {
    expect(swissPostEventStage('PARCEL.*.2.4000', 'CANPDS')).toBeUndefined();
    expect(swissPostEventStage('LETTER.*.1.4000', 'CAN1')).toBeUndefined();
    expect(swissPostEventStage('PARCEL.*.2.4000', '1')).toBe('delivered');
    const result = parseSwissPostShipment({ globalStatus: 'IN_DELIVERY' }, [
      { eventCode: 'PARCEL.*.1.1003', timestamp: '2026-09-01T08:00:00+02:00' },
      { eventCode: 'PARCEL.*.1.4000', subEventId: 'CANPDS', subEventDetailCode: '7', timestamp: '2026-09-01T09:00:00+02:00' },
    ], { 'PARCEL.*.*.4000.*': 'Delivered', 'PARCEL.*.*.4000.*.CANPDS.7': 'Revocation' });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered — Revocation' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('falls back to the shipment summary when the newest scan has no stage', () => {
    const result = parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED' }, [
      { eventCode: 'LETTER.*.82.924', timestamp: '2026-09-02T10:00:00+02:00' },
      { eventCode: 'LETTER.*.82.9112', timestamp: '2026-09-09T10:00:00+02:00' },
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseSwissPostShipment({ globalStatus: 'REPORTED' }, [])).toMatchObject({
      status: 'pending', current_stage: 'registered',
    });
  });

  it('reads a shipment that came back to its sender as returned, not delivered', () => {
    const history = [
      { eventCode: 'LETTER.*.93.923', timestamp: '2026-05-04T11:51:00+02:00' },
      { eventCode: 'LETTER.*.93.4000', timestamp: '2026-05-23T07:59:55+02:00' },
    ];
    const enquiry = { eventCode: 'LETTER.*.93.9112', timestamp: '2026-06-08T16:06:14+02:00' };
    for (const [shipment, events] of [
      [{ globalStatus: 'RETURNED', returned: true, calculatedDeliveryDate: '2026-05-06' }, [...history, enquiry]],
      [{ globalStatus: 'RETURNED' }, history],
      [{ globalStatus: 'DELIVERED', returned: true }, history],
    ] as Array<[JsonObject, JsonObject[]]>) {
      const result = parseSwissPostShipment(shipment, events);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
      expect(result).not.toHaveProperty('delivered_at');
    }
  });

  it('keeps forwarding scans in transit after loading onto the delivery vehicle', () => {
    const result = parseSwissPostShipment({ globalStatus: 'IN_DELIVERY' }, [
      { eventCode: 'PARCEL.*.2.820', timestamp: '2026-09-01T05:00:00+02:00' },
      { eventCode: 'PARCEL.*.1.1003', timestamp: '2026-09-01T08:00:00+02:00' },
    ]);
    expect(result.current_stage).toBe('out_for_delivery');
    expect(result.events?.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit']);
  });

  it('keeps a MyPost24 deposit ready for pickup even if the carrier summary says delivered', () => {
    const result = parseSwissPostShipment({ globalStatus: 'DELIVERED' }, [
      { eventCode: 'PARCEL.*.1.2102', timestamp: '2026-09-01T08:00:00+02:00' },
    ], { 'PARCEL.*.1.2102.INLAND': 'Deposited in the MyPost24 machine' });
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'ready_for_pickup',
      events: [{ stage: 'ready_for_pickup' }],
    });
  });
});

describe('Swiss Post projection', () => {
  it('keeps an explicit scan country when the city is absent without assuming Switzerland', () => {
    const locations = (events: JsonObject[]) => parseSwissPostShipment({ globalStatus: 'DELIVERED' }, events)
      .events?.map((event) => event.location);
    const scan = { eventCode: 'PARCEL.*.1.3800', timestamp: '2026-07-12T10:15:00Z' };
    expect(locations([{ ...scan, country: 'CH' }])).toEqual(['CH']);
    expect(locations([{ ...scan, country: 'DE', zip: '12345' }])).toEqual(['DE']);
    expect(locations([{ ...scan, country: 'CH', city: 'Example Depot', zip: '100000' }]))
      .toEqual(['Example Depot 100000']);
    for (const country of [undefined, '', 'ZZ', ['CH'], { code: 'CH' }]) {
      expect(locations([{ ...scan, country }])).toEqual(['']);
    }
  });

  it('ignores structured text without stringifying it into shipment data', () => {
    const result = parseSwissPostShipment({ globalStatus: ['DELIVERED'], shipmentNumber: ['993412345612345678'],
      internationalBarcode: ['RA123456785CH'], lastEventDateTime: ['2026-01-01'], calculatedDeliveryDate: ['2026-01-02'] }, [
      { eventCode: ['PARCEL.*.1.1003'], timestamp: '2026-01-01T12:00:00Z' },
      { eventCode: 'PARCEL.*.1.1003', timestamp: ['2026-01-01T12:00:00Z'] },
    ]);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: '', last_update: null, expected_delivery: null, events: [] });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.international_tracking_number).toBeUndefined();
    const numeric = parseSwissPostShipment({ shipmentNumber: 12345678 }, [
      { eventCode: 'PARCEL.*.1.1003', timestamp: '2026-01-01T12:00:00Z', city: 'Test  Depot', zip: 1000 },
    ]);
    expect(numeric.canonical_tracking_number).toBe('12345678');
    expect(numeric.events?.[0]?.location).toBe('Test  Depot 1000');
  });

  it('reads the weight in grams and the measurements in millimetres', () => {
    const parse = (physicalProperties: unknown, extra: JsonObject = {}) =>
      parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED', physicalProperties, ...extra }, []);
    expect(parse({ weight: 42, dimension1: 195, dimension2: 195 })).toMatchObject({
      weight_kg: 0.042, dimensions_text: '19.5 × 19.5 cm',
    });
    expect(parse({ weight: 11580, dimension1: 570, dimension2: 400, dimension3: 145 })).toMatchObject({
      weight_kg: 11.58, dimensions_text: '57 × 40 × 14.5 cm',
    });
    for (const unmeasured of [{ weight: 0, dimension1: 236 }, { weight: '', dimension1: null }, null, 'heavy']) {
      const result = parse(unmeasured);
      expect(result).not.toHaveProperty('weight_kg');
      expect(result).not.toHaveProperty('dimensions_text');
    }
    expect(parse({}, { recipientCountry: 'sv' })).toMatchObject({ destination_country: 'SV' });
    for (const recipientCountry of ['', 'Switzerland', ['CH'], null]) {
      expect(parse({}, { recipientCountry })).not.toHaveProperty('destination_country');
    }
  });

  it('dates the delivery from the shipment record, else from the delivery scan', () => {
    const scan = { eventCode: 'LETTER.*.10.4000', timestamp: '2026-07-28T08:22:56+02:00' };
    expect(parseSwissPostShipment({ globalStatus: 'DELIVERED', deliveryDate: '2026-07-28T08:23:10+02:00' }, [scan]))
      .toMatchObject({ delivered_at: '2026-07-28T08:23:10+02:00', expected_delivery: null });
    expect(parseSwissPostShipment({ globalStatus: 'DELIVERED', deliveryDate: '2026-07-28' }, [scan]))
      .toMatchObject({ delivered_at: '2026-07-28T08:22:56+02:00' });
    expect(parseSwissPostShipment({ globalStatus: 'DELIVERED' }, [scan]))
      .toMatchObject({ delivered_at: '2026-07-28T08:22:56+02:00' });
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'location', 'eta', 'pickup_point', 'provider_code', 'weight', 'dimensions', 'delivered_at']);
    const { shipment, events, translations } = outForDelivery();
    const result = parseSwissPostShipment(shipment, events, translations);
    expect(result).toMatchObject({ weight_kg: 0.72, dimensions_text: '23 × 16 × 11.5 cm', destination_country: 'CH' });
    expect(result).not.toHaveProperty('delivered_at');
    const delivered = parseSwissPostShipment({ ...shipment, globalStatus: 'DELIVERED' }, [
      { eventCode: 'PARCEL.*.1.4001', timestamp: '2026-09-12T10:41:00+02:00' },
      ...events,
    ], translations);
    expect(delivered).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-09-12T10:41:00+02:00', expected_delivery: null,
    });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.some((event) => event.provider_code)).toBe(true);
    expect(result.expected_delivery).toBe('2026-09-12 09:00–12:00');
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'Loading into delivery vehicle',
      canonical_tracking_number: '993412345612345678',
      international_tracking_number: 'RA123456785CH',
      timezone: 'Europe/Zurich',
    });
  });

  it('discards the recipient, address, signature and contact fields', () => {
    const { shipment, events, translations } = outForDelivery();
    const serialized = JSON.stringify(parseSwissPostShipment(shipment, events, translations));
    for (const privateValue of [
      'PRIVATE RECIPIENT',
      'PRIVATE STREET 7',
      'PRIVATE SIGNATURE',
      'private@example.test',
      'private-summary-id',
    ]) expect(serialized).not.toContain(privateValue);
  });
});

describe('Swiss Post pickup point', () => {
  const OFFICE = {
    zip: '999973', zip4: '9999', postOffice: false, postAgency: false, street: 'MP Example', streetNumber: null,
    addressCity: 'Example Town', addressZip: '999900', description: 'My Post 24 9999 Example Town Station',
    descriptionName: null, city: 'Example Town',
  };
  const waiting = {
    identity: 'private-summary-id', shipmentNumber: WRONG_SWISS_POST_NUMBER, globalStatus: 'MISSED_DELIVERY',
    addresseeType: 'MY_POST_24', deliveryPostOfficeZip: '999973',
    addressee: { name1: 'PRIVATE RECIPIENT', street: 'PRIVATE STREET', number: '7', zip: '9998', city: 'PRIVATE TOWN' },
    avis: { deliveryPostOfficeZip: '999973', arrivalPostOfficeZip: null, deadline: '2026-09-11T00:00:00+02:00', isMyPost24: true },
  };
  const deposited = { eventCode: 'PARCEL.*.1.2102', timestamp: '2026-08-31T14:03:17+02:00', zip: '999973',
    city: 'Example Town Station My Post 24', country: 'CH' };
  const collected = { eventCode: 'PARCEL.*.1.4000', timestamp: '2026-09-01T15:05:01+02:00', zip: null, city: null, country: 'CH' };

  function lookup(item: JsonObject, events: JsonObject[], office: (init?: RequestInit) => Response | Promise<Response> = () =>
    new Response(JSON.stringify(OFFICE))) {
    const urls: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ userIdentifier: 'unit-test-user' }), { headers: { 'x-csrf-token': 'unit-test-csrf' } });
      }
      if (url.includes('/history?')) return new Response(JSON.stringify({ hash: 'unit-test-hash' }));
      if (url.includes('/history/not-included/')) return new Response(JSON.stringify([item]));
      if (url.endsWith('/events')) return new Response(JSON.stringify(events));
      if (url.includes('/autocomplete/postoffice/id/')) return office(init);
      return new Response(JSON.stringify({ 'shipment-text--': { 'PARCEL.*.1.2102.INLAND': 'Deposited in the MyPost24 machine' } }));
    };
    return { urls, tracker: new SwissPostTracker({ fetcher }) };
  }

  it('names the office or terminal holding the parcel and its address only while it waits there', async () => {
    const app = lookup(waiting, [deposited]);
    const result = await app.tracker.fetch(WRONG_SWISS_POST_NUMBER);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup',
      pickup_point: 'My Post 24 9999 Example Town Station\nMP Example\n9999 Example Town' });
    expect(app.urls.filter((url) => url.includes('/autocomplete/'))).toEqual([
      'https://service.post.ch/ekp-web/api/autocomplete/postoffice/id/999973']);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|9998|2026-09-11/);
    const done = lookup(waiting, [deposited, collected]);
    const delivered = await done.tracker.fetch(WRONG_SWISS_POST_NUMBER);
    expect(delivered).toMatchObject({ current_stage: 'delivered' });
    expect(delivered.pickup_point).toBeUndefined();
    expect(done.urls.some((url) => url.includes('/autocomplete/'))).toBe(false);
  });

  it('asks for the arrival office first, as the tracker page does, and only for a site number', async () => {
    const forwarded = lookup({ ...waiting, avis: { ...waiting.avis, arrivalPostOfficeZip: '999950' } }, [deposited],
      () => new Response(JSON.stringify({ ...OFFICE, zip: '999950' })));
    await forwarded.tracker.fetch(WRONG_SWISS_POST_NUMBER);
    expect(forwarded.urls.filter((url) => url.includes('/autocomplete/'))).toEqual([
      'https://service.post.ch/ekp-web/api/autocomplete/postoffice/id/999950']);
    for (const avis of [undefined, { deliveryPostOfficeZip: '9999' }, { deliveryPostOfficeZip: ['999973'] }]) {
      const app = lookup({ ...waiting, avis }, [deposited]);
      expect((await app.tracker.fetch(WRONG_SWISS_POST_NUMBER)).pickup_point).toBeUndefined();
      expect(app.urls.some((url) => url.includes('/autocomplete/'))).toBe(false);
    }
  });

  it('reads a branch, a partner shop and a terminal as their records give them', () => {
    const branch = { zip: '999901', zip4: '9998', postOffice: true, street: 'Example Street', streetNumber: '9B',
      city: 'Example Town', addressZip: '999800', description: 'Filiale 9999 Example Town 1', descriptionName: 'Die Post Example Town 1' };
    expect(swissPostPickupPoint(branch, '999901')).toBe('Filiale 9999 Example Town 1\nExample Street 9B\n9998 Example Town');
    expect(swissPostPickupPoint({ ...branch, description: 'My Post Service 9999 Example Town Kiosk', descriptionName: 'My Post Service' },
      '999901')).toBe('My Post Service 9999 Example Town Kiosk\nExample Street 9B\n9998 Example Town');
    // A terminal's record can name it again in place of a street.
    expect(swissPostPickupPoint({ ...OFFICE, street: OFFICE.description }, '999973'))
      .toBe('My Post 24 9999 Example Town Station\n9999 Example Town');
    expect(swissPostPickupPoint({ ...OFFICE, street: null }, '999973')).toBe('My Post 24 9999 Example Town Station\n9999 Example Town');
  });

  it('keeps the name alone without a town, and nothing without a name', () => {
    expect(swissPostPickupPoint({ ...OFFICE, zip4: '999900' }, '999973')).toBe('My Post 24 9999 Example Town Station');
    expect(swissPostPickupPoint({ ...OFFICE, city: null }, '999973')).toBe('My Post 24 9999 Example Town Station');
    expect(swissPostPickupPoint({ ...OFFICE, description: ['Example'] }, '999973')).toBe('');
    expect(swissPostPickupPoint([OFFICE], '999973')).toBe('');
  });

  it.each([
    ['another site', () => new Response(JSON.stringify({ ...OFFICE, zip: '999974' }))],
    ['an empty record', () => new Response('{}')],
    ['a blocked reply', () => new Response('<html>sorry</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['an outage', () => new Response('', { status: 503 })],
  ])('keeps the parcel without a pickup point after %s', async (_, reply) => {
    const result = await lookup(waiting, [deposited], reply).tracker.fetch(WRONG_SWISS_POST_NUMBER);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', events: [{ provider_code: 'PARCEL.*.1.2102' }] });
    expect(result.pickup_point).toBeUndefined();
  });

  it('ends a lookup cancelled during the office request', async () => {
    const controller = new AbortController();
    const app = lookup(waiting, [deposited], () => {
      controller.abort(new Error('Cancelled'));
      return new Response('', { status: 503 });
    });
    await expect(app.tracker.fetch(WRONG_SWISS_POST_NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
  });
});

describe('Swiss Post translation table', () => {
  it('is requested again after a lookup cancelled while it loaded', async () => {
    const { shipment, events, translations } = outForDelivery();
    const controller = new AbortController();
    let tableRequests = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ userIdentifier: 'unit-test-user' }), { headers: { 'x-csrf-token': 'unit-test-csrf' } });
      }
      if (url.includes('/history?')) return new Response(JSON.stringify({ hash: 'unit-test-hash' }));
      if (url.includes('/history/not-included/')) return new Response(JSON.stringify([shipment]));
      if (url.endsWith('/events')) return new Response(JSON.stringify(events));
      tableRequests += 1;
      if (tableRequests > 1) return new Response(JSON.stringify({ 'shipment-text--': translations }));
      const signal = init!.signal!;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort(new Error('caller cancelled'));
      });
    };
    const tracker = new SwissPostTracker({ fetcher });

    await expect(tracker.fetch('993412345612345678', { signal: controller.signal })).rejects.toThrow('unreachable');
    const result = await tracker.fetch('993412345612345678');

    expect(tableRequests).toBe(2);
    expect(result.events?.[1]?.description).toBe('Shipment is being forwarded');
  });

  it('is requested again after a lookup whose budget ran out while it loaded', async () => {
    const { translations } = outForDelivery();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ 'shipment-text--': translations })));
    const tracker = new SwissPostTracker();
    // The request's own timer fired just ahead of the budget's signal.
    const spent: LookupBudget = { signal: new AbortController().signal, budgetMs: 40, deadline: 0, remainingMs: () => 3 };

    await expect(tracker.loadTranslations(fetcher, spent)).rejects.toThrow('unreachable');
    await expect(tracker.loadTranslations(fetcher)).resolves.toEqual(translations);
  });
});

describe('Swiss Post no-data response', () => {
  it('runs the anonymous search flow and maps an empty result to a clean 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userIdentifier: '<[anonymous]>unit-test-user',
      }), {
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': 'unit-test-csrf',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'unit-test-hash' }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('[]', {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER))
      .rejects.toBeInstanceOf(NotFoundError);

    expect(fetcher).toHaveBeenCalledTimes(3);
    const historyRequest = fetcher.mock.calls[1]!;
    expect(String(historyRequest[0])).toContain('/ekp-web/api/history?userId=');
    expect(historyRequest[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ searchQuery: WRONG_SWISS_POST_NUMBER }),
    });
    expect(String(fetcher.mock.calls[2]?.[0])).toContain('/history/not-included/unit-test-hash?');
  });

  it('keeps malformed non-array results distinct from no data', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ userIdentifier: 'unit-test-user' }), {
        headers: { 'x-csrf-token': 'unit-test-csrf' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hash: 'unit-test-hash' })))
      .mockResolvedValueOnce(new Response('{}'));

    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER))
      .rejects.toThrow('Swiss Post returned an invalid shipment response');
  });

  it('selects the matching shipment rather than accepting the first result', async () => {
    const fetcher = mockSearchResult([
      { shipmentNumber: 'OTHER-SHIPMENT-ID', globalStatus: 'DELIVERED' },
      { shipmentNumber: '989.999.999.999.999.999', globalStatus: 'REGISTERED' },
    ]);

    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER)).resolves.toMatchObject({
      status: 'pending',
      global_status: 'REGISTERED',
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('resolves an exact international barcode to the domestic delivery number', async () => {
    mockSearchResult([{ shipmentNumber: WRONG_SWISS_POST_NUMBER, internationalBarcode: '12345678901', globalStatus: 'IN_DELIVERY' }]);
    await expect(new SwissPostTracker().fetch('12345678901')).resolves.toMatchObject({
      status: 'out_for_delivery', canonical_tracking_number: WRONG_SWISS_POST_NUMBER,
      international_tracking_number: '12345678901',
    });
  });

  it('rejects ambiguous international references even when one domestic number matches', async () => {
    mockSearchResult([
      { shipmentNumber: WRONG_SWISS_POST_NUMBER, globalStatus: 'IN_DELIVERY' },
      { shipmentNumber: '990000000000000001', internationalBarcode: WRONG_SWISS_POST_NUMBER, globalStatus: 'DELIVERED' },
    ]);
    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER)).rejects.toThrow('ambiguous shipment');
  });

  it('rejects mismatched and non-identifying result arrays', async () => {
    mockSearchResult([{ shipmentNumber: 'OTHER-SHIPMENT-ID', globalStatus: 'DELIVERED' }]);
    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER))
      .rejects.toThrow('Swiss Post returned a different shipment');

    vi.restoreAllMocks();
    mockSearchResult([{ identity: 'private-summary-id', globalStatus: 'REGISTERED' }]);
    await expect(new SwissPostTracker().fetch(WRONG_SWISS_POST_NUMBER))
      .rejects.toThrow('Swiss Post did not return a shipment identifier');
  });
});
