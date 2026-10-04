import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupBudget } from '../../core/adapter/index.js';
import { NotFoundError } from '../../core/errors/index.js';
import type { JsonObject } from '../../core/types.js';
import { parseSwissPostShipment, SwissPostTracker } from './adapter.js';
import { EVENT_STAGE_BY_CODE, LETTER_IMPORT_STAGE_BY_CODE, swissPostEventStage } from './status.js';

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
    ['620', 'Consignment recorded by the foreign sender (data delivered)', 'registered'],
    ['803', 'Customs clearance process underway', 'customs'],
    ['804', 'Completion of customs clearance process', 'in_transit'],
    ['805', 'Completion of customs clearance process', 'in_transit'],
    ['818', 'Arrival in destination country', 'in_transit'],
    ['912', 'Time at which your consignment was mailed', 'accepted'],
    ['915', 'The consignment has left the border point', 'in_transit'],
    ['1001', 'Arrival at the collection/delivery point', 'in_transit'],
    ['1213', 'Sorted for delivery', 'in_transit'],
    ['1218', 'Sorted for delivery', 'in_transit'],
  ])('classifies international postal handoff scan %s from its code', (code, description, stage) => {
    expect(LETTER_IMPORT_STAGE_BY_CODE[code]).toBe(stage);
    expect(swissPostEventStage(`LETTER.*.90.${code}`)).toBe(stage);
    const result = parseSwissPostShipment({ globalStatus: 'TO_BE_DELIVERED' }, [
      { eventCode: `LETTER.*.90.${code}`, timestamp: '2026-09-10T07:00:00+02:00', externalMetadata: { description } },
    ]);
    expect(result.current_stage).toBe(stage);
    expect(result.events?.[0]).toMatchObject({ description, stage });
  });

  it('uses the parcel table outside the LETTER import range', () => {
    expect(swissPostEventStage('PARCEL.*.1.1003')).toBe(EVENT_STAGE_BY_CODE['1003']);
    expect(swissPostEventStage('LETTER.*.1.803')).toBeUndefined();
    expect(swissPostEventStage('PARCEL.*.1.9999')).toBeUndefined();
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

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'location', 'eta', 'provider_code']);
    const { shipment, events, translations } = outForDelivery();
    const result = parseSwissPostShipment(shipment, events, translations);
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
