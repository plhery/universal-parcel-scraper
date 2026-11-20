import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { carrierErrorKind, IndeterminateError, MaintenanceError, NotFoundError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import type { JsonObject } from '../../core/types.js';
import { adapter, parseSwissPostShipment, swissPostExpectedDelivery, SwissPostTracker } from './adapter.js';
import { EVENT_STAGE_BY_CODE, swissPostEventStage, SWISS_POST_GLOBAL_STATUSES } from './status.js';

const SHIPMENT = '993412345699999980';
/** Swiss Post's public outage page, served in place of JSON, with HTTP 200, while its service is down. */
const OUTAGE_PAGE = `<!--
  ~ Copyright 2025 by Swiss Post, Information Technology
  -->
<!DOCTYPE html>
<html>
<head>
\t<title>Die Schweizerische Post AG</title>
\t<meta http-equiv="content-security-policy" content="default-src 'none'; base-uri 'none'; form-action 'none';">
\t<meta http-equiv="refresh" content="0; url=https://sorry.post.ch">
</head>
<body>
</body>
</html>
`;

/** The fixture's item detail, and the search's summary of it: the same item without its scans. */
function outForDelivery(): { detail: JsonObject; summary: JsonObject; events: JsonObject[] } {
  const detail = JSON.parse(readFileSync(new URL('./fixtures/out-for-delivery.json', import.meta.url), 'utf8')) as JsonObject;
  const summary = Object.fromEntries(Object.entries(detail).filter(([key]) => !['events', 'documents', 'billingItems'].includes(key)));
  return { detail, summary, events: detail.events as JsonObject[] };
}
const capabilities = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

/** An item of the given type and product with the given scans, as the item detail gives them. */
const item = (extra: JsonObject = {}): JsonObject => ({ type: 'PARCEL', product: { code: '1' }, status: { status: 'ON_GOING_DELIVERY' }, ...extra });
const scan = (code: string, timestamp: string, extra: JsonObject = {}): JsonObject => ({ code, timestamp, location: {}, title: '', ...extra });

/**
 * A tracker whose search answers `search` and whose item detail answers the fixture, but for the
 * calls matching `step`, which get `reply`.
 */
function tracker(options: { search?: () => Response; step?: RegExp; reply?: () => Response } = {}) {
  const { detail, summary } = outForDelivery();
  const calls: Array<{ url: string; language: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, language: new Headers(init?.headers).get('accept-language') });
    if (options.step?.test(url) && options.reply) return options.reply();
    if (url.includes('/compact/?')) return options.search?.() ?? Response.json({ mailpieces: [summary] });
    if (url.endsWith('/detail')) return Response.json(detail);
    return new Response('unexpected', { status: 404 });
  };
  return { calls, fetcher, tracker: new SwissPostTracker({ fetcher }) };
}

const failure = (promise: Promise<unknown>) => promise.then(() => expect.unreachable('the lookup succeeded'), (error: unknown) => error);

afterEach(() => vi.restoreAllMocks());

describe('Swiss Post event codes', () => {
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
    ['2000', 'Delivered over counter', 'delivered'],
    ['3700', 'The recipient has refused delivery', 'exception'],
    ['3800', 'Delivered to the mailbox/letter box', 'delivered'],
    ['4020', 'Forwarding abroad', 'in_transit'],
    ['9400', 'Consignment poste restante in post office and ready for collection', 'ready_for_pickup'],
  ])('classifies scan %s from its code for letters and parcels alike', (code, title, stage) => {
    expect(EVENT_STAGE_BY_CODE[code]).toBe(stage);
    expect(swissPostEventStage(code)).toBe(stage);
    for (const [type, product] of [['LETTER', '90'], ['LETTER', '93'], ['PARCEL', '2']]) {
      const result = parseSwissPostShipment(item({ type, product: { code: product } }), [
        scan(code, '2026-09-10T07:00:00+02:00', { title }),
      ]);
      expect(result.current_stage).toBe(stage);
      // Written as the former tracker wrote it, and as stored scans carry it.
      expect(result.events?.[0]).toMatchObject({ description: title, stage, provider_code: `${type}.*.${product}.${code}` });
    }
  });

  it('keeps the bare code when the item names no type or product', () => {
    expect(parseSwissPostShipment({ status: { status: 'DELIVERED' } }, [scan('4000', '2026-09-10T07:00:00+02:00')]).events?.[0])
      .toMatchObject({ provider_code: '4000', stage: 'delivered' });
    expect(parseSwissPostShipment(item({ product: { code: ['1'] } }), [scan('4000', '2026-09-10T07:00:00+02:00')]).events?.[0])
      .toMatchObject({ provider_code: '4000' });
  });

  it('leaves unknown codes, enquiry and delay notes and recipient orders to the wording', () => {
    expect(swissPostEventStage('PARCEL.*.1.1003')).toBe(EVENT_STAGE_BY_CODE['1003']);
    for (const code of ['9999', '9112', '1800', '9224', '811', 'LETTER.*.93.9112', 'LETTER.*.83.811']) expect(swissPostEventStage(code)).toBeUndefined();
  });

  it('reads a parcel held at a post office after a refusal as ready for collection', () => {
    const result = parseSwissPostShipment(item(), [
      scan('3700', '2026-09-08T10:55:00+02:00'),
      scan('1001', '2026-09-10T16:34:21+02:00'),
      scan('9400', '2026-09-10T16:34:29+02:00'),
    ]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup' });
  });

  it('drops the copy without a place of a scan Swiss Post lists twice at one instant', () => {
    const arrival = scan('818', '2026-09-10T14:48:56+02:00', { title: 'Arrival in destination country' });
    const result = parseSwissPostShipment(item({ type: 'LETTER', product: { code: '106' } }), [
      arrival,
      { ...arrival, location: { city: 'Example Briefzentrum', zipCode: '9999', country: 'CH' } },
    ]);
    expect(result.events).toEqual([expect.objectContaining({ location: 'Example Briefzentrum 9999' })]);
  });

  it('keeps scans of one instant in the order Swiss Post lists them, newest first', () => {
    const same = '2026-09-01T06:16:00+02:00';
    const result = parseSwissPostShipment(item(), [
      scan('924', '2026-09-01T08:21:00+02:00'), scan('909', same), scan('921', same), scan('906', '2026-09-01T03:15:00+02:00'),
    ]);
    expect(result.events?.map((event) => event.provider_code?.split('.').at(-1))).toEqual(['924', '909', '921', '906']);
  });

  it('adds the detail the tracker shows under a scan, and takes no stage from a revoked one', () => {
    const detail = (information: string) => ({ additionalInformation: { code: '1', information } });
    const delivered = parseSwissPostShipment(item(), [scan('4000', '2026-09-10T13:53:01+02:00',
      { title: 'Delivered', subtitle: 'Deposited with authorization for delivery', ...detail('Deposited with authorization for delivery') })]);
    expect(delivered.events?.[0]).toMatchObject({ description: 'Delivered — Deposited with authorization for delivery', stage: 'delivered' });
    expect(parseSwissPostShipment(item(), [scan('4000', '2026-09-10T13:53:01+02:00', { title: 'Delivered', ...detail('Delivered') })])
      .events?.[0]?.description).toBe('Delivered');
    const revoked = parseSwissPostShipment(item(), [
      scan('1003', '2026-09-10T07:00:00+02:00', { title: 'Loading into delivery vehicle' }),
      scan('4000', '2026-09-10T13:53:01+02:00', { title: 'Distribué', ...detail('Révocation') }),
    ]);
    expect(revoked.events?.[0]).toMatchObject({ description: 'Distribué — Révocation' });
    expect(revoked.events?.[0]).not.toHaveProperty('stage');
    expect(revoked.current_stage).toBe('in_transit');
  });

  it('words a scan without wording by its built-in label, else by its code', () => {
    const result = parseSwissPostShipment(item(), [scan('1003', '2026-09-10T07:00:00+02:00'), scan('7777', '2026-09-09T07:00:00+02:00')]);
    expect(result.events?.map((event) => event.description)).toEqual(['Loading into delivery vehicle', '7777']);
  });

  it("reads the destination post's unlocated events on its clock, not on the Swiss offset they carry", () => {
    const history = [
      scan('909', '2026-10-08T12:26+02:00'),
      scan('9112', '2026-10-06T06:45:39+02:00', { location: { country: 'CH' } }),
      scan('918', '2026-09-24T15:30:00+02:00'),
      scan('915', '2026-09-03T22:19:00+02:00'),
      scan('813', '2026-09-03T12:20:24+02:00', { location: { city: 'Example', zipCode: '9999', country: 'CH' } }),
    ];
    const exported = (host: string) => item({ type: 'LETTER', product: { code: '82' }, international: 'EXPORT',
      exportTrackingUrl: `https://${host}/track` });
    const clocks = (shipment: JsonObject) => parseSwissPostShipment(shipment, history).events?.map((event) => event.time);
    expect(clocks(exported('www.correos.gob.sv'))).toEqual([
      '2026-10-08T12:26:00-06:00', '2026-10-06T06:45:39+02:00', '2026-09-24T15:30:00-06:00',
      '2026-09-03T22:19:00+02:00', '2026-09-03T12:20:24+02:00']);
    expect(parseSwissPostShipment(exported('www.correos.gob.sv'), history)).toMatchObject({ destination_country: 'SV' });
    // A destination with several clocks keeps Swiss Post's offset, the last guess.
    const several = parseSwissPostShipment(exported('tools.usps.com'), history);
    expect(several).toMatchObject({ destination_country: 'US', last_update: '2026-10-08T12:26:00+02:00' });
    expect(several.events?.map((event) => event.time)).toEqual(history.map((event) => String(event.timestamp).replace(/T(\d\d:\d\d)\+/, 'T$1:00+')));
    // A destination the link does not name keeps every offset as sent.
    expect(clocks(exported('www.dhl.com'))?.[0]).toBe('2026-10-08T12:26:00+02:00');
    expect(parseSwissPostShipment(exported('www.dhl.com'), history)).not.toHaveProperty('destination_country');
    // An item arriving in Switzerland keeps every offset as sent.
    expect(clocks(item({ international: 'IMPORT', exportTrackingUrl: 'https://www.correos.gob.sv/track' }))?.[0])
      .toBe('2026-10-08T12:26:00+02:00');
    // China's customs scans too: UPU gives Beijing's office 11:05 and Hangzhou's 14:30.
    const customs = parseSwissPostShipment({ ...exported('www.ems.com.cn'), events: [] }, [
      scan('902', '2026-08-09T14:30+02:00'), scan('901', '2026-08-07T11:05+02:00'),
    ]);
    expect(customs.events?.map((event) => event.time)).toEqual(['2026-08-09T14:30:00+08:00', '2026-08-07T11:05:00+08:00']);
  });

  it("reads a London office of exchange's events on a parcel from abroad on London's clock", () => {
    const history = [
      scan('1202', '2026-10-23T18:38:15+02:00', { location: { city: 'Example Paketzentrum', zipCode: '9999', country: 'CH' } }),
      scan('915', '2026-10-16T17:57+02:00', { location: { city: 'LON E ET BEA' } }),
      scan('913', '2026-10-16T17:27+02:00', { location: { city: 'LON E ET BEA' } }),
      scan('912', '2026-10-16T16:57+02:00', { location: { city: 'Belgian Post' } }),
    ];
    const clocks = (shipment: JsonObject) => parseSwissPostShipment(shipment, history).events?.map((event) => event.time);
    // UPU has the departure at 17:57 +01:00. The posting names a post, not an office, and keeps Swiss Post's offset.
    expect(clocks(item({ international: 'IMPORT' }))).toEqual([
      '2026-10-23T18:38:15+02:00', '2026-10-16T17:57:00+01:00', '2026-10-16T17:27:00+01:00', '2026-10-16T16:57:00+02:00']);
    // Only a parcel from abroad passes an office abroad on its way in.
    expect(clocks(item())).toEqual(['2026-10-23T18:38:15+02:00', '2026-10-16T17:57:00+02:00', '2026-10-16T17:27:00+02:00',
      '2026-10-16T16:57:00+02:00']);
  });

  it("reads a consolidator's notice that its letter will shortly be handed over on Beijing's clock", () => {
    const letter = item({ type: 'LETTER', product: { code: '106' }, status: { status: 'NOT_YET_SENT' } });
    const history = [scan('818', '2026-10-27T09:06:11+01:00'), scan('859', '2026-10-26T18:12:57+01:00')];
    expect(parseSwissPostShipment(letter, history).events?.map((event) => event.time))
      .toEqual(['2026-10-27T09:06:11+01:00', '2026-10-26T18:12:57+08:00']);
    expect(parseSwissPostShipment(letter, history.slice(1)))
      .toMatchObject({ last_update: '2026-10-26T18:12:57+08:00', current_stage: 'registered' });
    // A notice hours ahead of the hub's deposit.
    const late = parseSwissPostShipment(letter, [scan('912', '2026-10-30T10:56:57+01:00'), scan('859', '2026-10-30T19:16:41+01:00')]);
    expect(late.events?.map((event) => event.time)).toEqual(['2026-10-30T19:16:41+08:00', '2026-10-30T10:56:57+01:00']);
    // Read so, it reached Swiss Post after the posting it announces: a notice on the posting's stage, which stays the parcel's.
    expect(late.events?.[0]).toMatchObject({ stage: 'accepted', stage_source: 'none' });
    expect(late).toMatchObject({ current_stage: 'accepted' });
    // Senders in Switzerland give their notice under another code, on Swiss Post's clock, as parcels do.
    expect(parseSwissPostShipment(letter, [scan('600', '2026-10-23T17:42:40+02:00')]).events?.[0]?.time)
      .toBe('2026-10-23T17:42:40+02:00');
  });

  it('falls back to the summary when the newest scan has no stage', () => {
    const result = parseSwissPostShipment(item(), [scan('924', '2026-09-02T10:00:00+02:00'), scan('9112', '2026-09-09T10:00:00+02:00')]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(parseSwissPostShipment(item({ status: { status: 'NOT_YET_SENT' } }), [])).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'NOT_YET_SENT', summary_only: true,
    });
    expect(parseSwissPostShipment(item({ status: { status: 'WAITING_FOR_PICKUP' } }), [])).toMatchObject({
      status: 'in_transit', current_stage: 'ready_for_pickup',
    });
    expect(parseSwissPostShipment(item({ status: { status: 'UNKNOWN' } }), [])).not.toHaveProperty('current_stage');
    // A status-only answer's text is one the app can tell from a scan, as it can the former tracker's.
    for (const code of ['NOT_YET_SENT', 'ON_GOING_DELIVERY', 'WAITING_FOR_PICKUP', 'DELIVERED', 'RETURNED', 'UNKNOWN', 'TO_BE_DELIVERED']) {
      expect(SWISS_POST_GLOBAL_STATUSES).toContain(code);
    }
  });

  it('reads an item that came back to its sender as returned, not delivered', () => {
    const history = [scan('923', '2026-05-04T11:51:00+02:00'), scan('4000', '2026-05-23T07:59:55+02:00')];
    const enquiry = scan('9112', '2026-06-08T16:06:14+02:00');
    const expectedDelivery = { from: '2026-05-06T00:00+02:00', to: '2026-05-06T23:59:59.999+02:00' };
    for (const [shipment, events] of [
      [item({ status: { status: 'DELIVERED', title: 'Return to sender', expectedDelivery }, badges: [{ title: 'Return item' }] }), [...history, enquiry]],
      [item({ status: { status: 'RETURNED' } }), history],
      ...['Rücksendung', 'Renvoi', 'Rinvio'].map((title) => [item({ status: { status: 'DELIVERED' }, badges: [{ title: 'International' }, { title }] }), history]),
    ] as Array<[JsonObject, JsonObject[]]>) {
      const result = parseSwissPostShipment(shipment, events);
      expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
      expect(result).not.toHaveProperty('delivered_at');
    }
    expect(parseSwissPostShipment(item({ status: { status: 'DELIVERED' }, badges: [{ title: 'International shipment' }] }), history))
      .toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps forwarding scans in transit after loading onto the delivery vehicle', () => {
    const result = parseSwissPostShipment(item(), [scan('820', '2026-09-01T05:00:00+02:00'), scan('1003', '2026-09-01T08:00:00+02:00')]);
    expect(result.current_stage).toBe('out_for_delivery');
    expect(result.events?.map((event) => event.stage)).toEqual(['out_for_delivery', 'in_transit']);
  });

  it('keeps a MyPost24 deposit ready for pickup even if the summary says delivered', () => {
    const result = parseSwissPostShipment(item({ status: { status: 'DELIVERED' } }), [scan('2102', '2026-09-01T08:00:00+02:00')]);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup', events: [{ stage: 'ready_for_pickup' }] });
  });

  it('keeps a parcel ready at its PickPost point after the point scans its arrival', () => {
    const scans = [scan('1003', '2026-09-01T08:00:00+02:00'), scan('2101', '2026-09-01T13:28:00+02:00'), scan('1001', '2026-09-01T13:29:00+02:00')];
    const result = parseSwissPostShipment(item(), scans);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'ready_for_pickup' });
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'ready_for_pickup', 'out_for_delivery']);
    // A new round or a delivery after the pickup notice takes the parcel out again.
    const later = (code: string) => parseSwissPostShipment(item(), [
      ...scans.slice(0, 2), scan(code, '2026-09-02T08:00:00+02:00'), scan('1001', '2026-09-02T09:00:00+02:00'),
    ]).current_stage;
    expect(later('1003')).toBe('in_transit');
    expect(later('4000')).toBe('in_transit');
    // An arrival with no pickup notice before it stays in transit.
    expect(parseSwissPostShipment(item(), [scans[0]!, scans[2]!]).current_stage).toBe('in_transit');
  });

  it('keeps a letter ready for collection when the counter scans its arrival after the notice left on the round', () => {
    const result = parseSwissPostShipment(item({ type: 'LETTER', product: { code: '106' } }), [
      scan('1001', '2026-09-01T06:14:00+02:00'),
      scan('2100', '2026-09-01T09:32:00+02:00'),
      scan('1300', '2026-09-01T12:23:00+02:00'),
      scan('1001', '2026-09-02T06:43:00+02:00'),
    ]);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'ready_for_pickup', 'in_transit']);
  });
});

describe('Swiss Post projection', () => {
  it("names a facility by its name and postcode, else by an explicit country, without assuming Switzerland", () => {
    const locations = (location: unknown) => parseSwissPostShipment(item(), [scan('3800', '2026-07-12T10:15:00Z', { location })])
      .events?.map((event) => event.location);
    expect(locations({ country: 'CH' })).toEqual(['CH']);
    expect(locations({ country: 'DE', zipCode: '12345' })).toEqual(['DE']);
    expect(locations({ city: 'Example Paketzentrum', zipCode: '9999', country: 'CH' })).toEqual(['Example Paketzentrum 9999']);
    expect(locations({ city: 'LON E ET BEA' })).toEqual(['LON E ET BEA']);
    for (const country of [undefined, '', 'ZZ', ['CH'], { code: 'CH' }]) {
      expect(locations({ country })).toEqual(['']);
      // A postcode alone is no place.
      expect(locations({ country, zipCode: '9999' })).toEqual(['']);
    }
    expect(locations(null)).toEqual(['']);
  });

  it('ignores structured text without stringifying it into shipment data', () => {
    const result = parseSwissPostShipment({ status: { status: ['DELIVERED'], expectedDelivery: { from: ['2026-01-02'] } },
      mailpieceId: [SHIPMENT], internationalMailpieceId: ['RA999999987CH'], lastUpdateTimestamp: ['2026-01-01'] }, [
      { code: ['1003'], timestamp: '2026-01-01T12:00:00Z' },
      { code: '1003', timestamp: ['2026-01-01T12:00:00Z'] },
    ]);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: '', last_update: null, expected_delivery: null, events: [] });
    expect(result.canonical_tracking_number).toBeUndefined();
    expect(result.international_tracking_number).toBeUndefined();
    const numeric = parseSwissPostShipment({ mailpieceId: 12345678 }, [
      scan('1003', '2026-01-01T12:00:00Z', { location: { city: 'Test  Depot', zipCode: 1000 } }),
    ]);
    expect(numeric.canonical_tracking_number).toBe('12345678');
    expect(numeric.events?.[0]?.location).toBe('Test  Depot 1000');
  });

  it('writes back the seconds the tracker leaves out when they are zero', () => {
    const result = parseSwissPostShipment(item({ status: { status: 'DELIVERED', deliveredTimestamp: '2026-07-23T06:30+02:00' } }), [
      scan('4001', '2026-07-23T06:30+02:00'), scan('1002', '2026-07-23T01:07:39+02:00'),
    ]);
    expect(result).toMatchObject({ delivered_at: '2026-07-23T06:30:00+02:00', last_update: '2026-07-23T06:30:00+02:00' });
    expect(result.events?.map((event) => event.time)).toEqual(['2026-07-23T06:30:00+02:00', '2026-07-23T01:07:39+02:00']);
  });

  it('reads the weight in grams and the measurements in millimetres', () => {
    const parse = (details: unknown) => parseSwissPostShipment(item({ physicalDimensions: { details } }), []);
    expect(parse({ weight: 42, length: 195, width: 195 })).toMatchObject({ weight_kg: 0.042, dimensions_text: '19.5 × 19.5 cm' });
    expect(parse({ weight: 11580, length: 570, width: 400, height: 145 })).toMatchObject({
      weight_kg: 11.58, dimensions_text: '57 × 40 × 14.5 cm',
    });
    for (const unmeasured of [{ weight: 0, length: 236 }, { weight: '', length: null }, null, 'heavy', {}]) {
      const result = parse(unmeasured);
      expect(result).not.toHaveProperty('weight_kg');
      expect(result).not.toHaveProperty('dimensions_text');
    }
  });

  it('places the item at home by its delivery postcode and abroad by the destination post it links', () => {
    const country = (extra: JsonObject) => parseSwissPostShipment(item(extra), []).destination_country;
    const address = (zipCode: unknown) => ({ recipientAddress: { address: ['9999 Example'], details: { zipCode } } });
    expect(country(address('8000'))).toBe('CH');
    expect(country(address('9490'))).toBe('LI');
    expect(country(address('9470'))).toBe('CH');
    for (const zipCode of ['', '80000', null]) expect(country(address(zipCode))).toBeUndefined();
    const exported = (exportTrackingUrl: unknown) => ({ ...address('8000'), international: 'EXPORT', exportTrackingUrl });
    expect(country(exported('https://www.post.at/s/sendungsdetails?snr=RA999999987CH'))).toBe('AT');
    expect(country(exported('https://www.deutschepost.de/de/s/sendungsverfolgung.html'))).toBe('DE');
    expect(country(exported('https://tools.usps.com/go/TrackConfirmAction'))).toBe('US');
    expect(country(exported('https://www.royalmail.co.uk/track'))).toBe('GB');
    for (const url of ['https://www.dhl.com/track', 'https://www.post.ch/track', 'not a link', null]) {
      expect(country(exported(url))).toBeUndefined();
    }
  });

  it('dates the delivery from the summary, else from the delivery scan', () => {
    const delivered = scan('4000', '2026-07-28T08:22:56+02:00');
    const summary = (deliveredTimestamp?: string) => item({ status: { status: 'DELIVERED', deliveredTimestamp } });
    expect(parseSwissPostShipment(summary('2026-07-28T08:23:10+02:00'), [delivered]))
      .toMatchObject({ delivered_at: '2026-07-28T08:23:10+02:00', expected_delivery: null });
    expect(parseSwissPostShipment(summary('2026-07-28'), [delivered])).toMatchObject({ delivered_at: '2026-07-28T08:22:56+02:00' });
    expect(parseSwissPostShipment(summary(), [delivered])).toMatchObject({ delivered_at: '2026-07-28T08:22:56+02:00' });
  });

  it('reads the delivery window as the tracker shows it', () => {
    const window = (from?: string, to?: string) => swissPostExpectedDelivery({ expectedDelivery: { from, to } });
    expect(window('2026-11-04T00:00+01:00', '2026-11-06T23:59:59.999+01:00')).toEqual({ from: '2026-11-04', to: '2026-11-06' });
    expect(window('2026-11-05T00:00+01:00', '2026-11-05T23:59:59.999+01:00')).toEqual({ from: null, to: '2026-11-05' });
    expect(window('2026-11-05T09:00+01:00', '2026-11-05T12:00:00.000+01:00')).toEqual({ from: null, to: '2026-11-05 09:00–12:00' });
    expect(window('2026-11-05T09:00+01:00', '2026-11-05T23:59:59.999+01:00')).toEqual({ from: null, to: '2026-11-05 09:00' });
    expect(window('2026-11-05T00:00+01:00')).toEqual({ from: null, to: '2026-11-05' });
    expect(window(undefined, '2026-11-05T12:00+01:00')).toEqual({ from: null, to: '2026-11-05 12:00' });
    expect(window()).toBeNull();
    expect(swissPostExpectedDelivery({})).toBeNull();
    const ranged = parseSwissPostShipment(item({ status: { status: 'ON_GOING_DELIVERY',
      expectedDelivery: { from: '2026-11-04T00:00+01:00', to: '2026-11-06T23:59:59.999+01:00' } } }), [scan('1202', '2026-11-03T20:00:00+01:00')]);
    expect(ranged).toMatchObject({ expected_delivery_from: '2026-11-04', expected_delivery: '2026-11-06' });
    expect(parseSwissPostShipment(item({ status: { status: 'DELIVERED',
      expectedDelivery: { from: '2026-11-04T00:00+01:00', to: '2026-11-06T23:59:59.999+01:00' } } }), [scan('4001', '2026-11-05T10:41:00+01:00')]))
      .toMatchObject({ expected_delivery: null });
  });

  it('covers every capability declared in carrier.json', () => {
    expect(capabilities).toEqual(['history', 'location', 'eta', 'provider_code', 'weight', 'dimensions', 'delivered_at']);
    const { detail, events } = outForDelivery();
    const result = parseSwissPostShipment(detail, events);
    expect(result).toMatchObject({ weight_kg: 0.72, dimensions_text: '23 × 16 × 11.5 cm', destination_country: 'CH' });
    expect(result).not.toHaveProperty('delivered_at');
    const delivered = parseSwissPostShipment({ ...detail, status: { status: 'DELIVERED' } }, [scan('4001', '2026-09-12T10:41:00+02:00'), ...events]);
    expect(delivered).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-09-12T10:41:00+02:00', expected_delivery: null,
    });
    expect(result.events).toEqual([
      { time: '2026-09-12T08:00:00+02:00', location: 'Zurich 8000', description: 'Loading into delivery vehicle',
        provider_code: 'PARCEL.*.1.1003', stage: 'out_for_delivery' },
      { time: '2026-09-11T21:30:00+02:00', location: 'Härkingen Paketzentrum 4622', description: 'Sorted for delivery',
        provider_code: 'PARCEL.*.1.1201', stage: 'in_transit' },
      { time: '2026-09-10T17:05:00+02:00', location: 'CH',
        description: 'Shipment data transmitted – Shipment not yet handed over to Swiss Post', provider_code: 'PARCEL.*.1.600', stage: 'registered' },
    ]);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      last_status_text: 'Loading into delivery vehicle',
      expected_delivery: '2026-09-12 09:00–12:00',
      canonical_tracking_number: SHIPMENT,
      global_status: 'ON_GOING_DELIVERY',
      timezone: 'Europe/Zurich',
    });
    expect(result).not.toHaveProperty('international_tracking_number');
    expect(parseSwissPostShipment({ ...detail, internationalMailpieceId: 'RA 999 999 987 CH' }, events))
      .toMatchObject({ international_tracking_number: 'RA999999987CH' });
  });

  it("reads the delivery address an anonymous lookup gets, and drops the sender's and the documents", () => {
    const { detail, events } = outForDelivery();
    const result = parseSwissPostShipment(detail, events);
    expect(result).toMatchObject({ receiver_address: '8000 Zurich' });
    expect(result).not.toHaveProperty('receiver_name');
    expect(parseSwissPostShipment({ ...detail, recipientAddress: { address: ['', ' '] } }, events)).not.toHaveProperty('receiver_address');
    expect(parseSwissPostShipment({ ...detail, recipientAddress: null }, events)).not.toHaveProperty('receiver_address');
    const serialized = JSON.stringify(result);
    for (const privateValue of ['PRIVATE SENDER', '3000 Bern', 'private-document-id', 'synthetic-mailpiece-key']) {
      expect(serialized).not.toContain(privateValue);
    }
  });
});

describe('Swiss Post lookup', () => {
  it('searches the number, then asks for the item by the key the search gives', async () => {
    const app = tracker();
    await expect(app.tracker.fetch('99.34.123456.99999980')).resolves.toMatchObject({
      status: 'out_for_delivery', canonical_tracking_number: SHIPMENT, events: [expect.anything(), expect.anything(), expect.anything()],
    });
    expect(app.calls.map((call) => call.url)).toEqual([
      'https://mys.post.ch/mailpiece-tracking-api/logistics/mailpiece/tracking/v2/mailpieces/compact/'
        + `?mailpieceId=${SHIPMENT}&includeAvailableServices=false`,
      'https://mys.post.ch/mailpiece-tracking-api/logistics/mailpiece/tracking/v2/mailpieces/compact/synthetic-mailpiece-key/detail',
    ]);
  });

  it('maps an empty search to a clean 404', async () => {
    const app = tracker({ search: () => Response.json({ mailpieces: [] }) });
    await expect(app.tracker.fetch(SHIPMENT)).rejects.toMatchObject({
      name: 'NotFoundError', status: 404, message: 'Swiss Post could not locate the shipment',
    });
    expect(app.calls).toHaveLength(1);
  });

  it.each([
    ['no list', {}],
    ['a list of something else', { mailpieces: ['x'] }],
    ['an array', []],
  ])('keeps a search answering %s malformed, not missing', async (_, body) => {
    const error = await failure(tracker({ search: () => Response.json(body) }).tracker.fetch(SHIPMENT));
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ message: 'Swiss Post returned an invalid shipment response' });
  });

  it('selects the matching item rather than accepting the first', async () => {
    const { summary } = outForDelivery();
    const other = { ...summary, mailpieceId: '993412345699999981', mailpieceKey: 'other-key' };
    const app = tracker({ search: () => Response.json({ mailpieces: [other, summary] }) });
    await expect(app.tracker.fetch(SHIPMENT)).resolves.toMatchObject({ canonical_tracking_number: SHIPMENT });
    expect(app.calls[1]?.url).toContain('/synthetic-mailpiece-key/detail');
  });

  it('finds a parcel from or to abroad by its international number', async () => {
    const { summary } = outForDelivery();
    const app = tracker({ search: () => Response.json({ mailpieces: [{ ...summary, internationalMailpieceId: 'RA999999987CH' }] }) });
    await expect(app.tracker.fetch('RA999999987CH')).resolves.toMatchObject({ canonical_tracking_number: SHIPMENT });
  });

  it.each([
    ['another item', () => [{ mailpieceId: '993412345699999981', mailpieceKey: 'k' }], 'Swiss Post returned a different shipment'],
    ['two items under the number', () => {
      const { summary } = outForDelivery();
      return [summary, { ...summary, mailpieceKey: 'other-key' }];
    }, 'Swiss Post returned an ambiguous shipment'],
    ['items without a number', () => [{ mailpieceKey: 'k' }], 'Swiss Post did not return a shipment identifier'],
  ])('refuses %s', async (_, mailpieces, message) => {
    await expect(tracker({ search: () => Response.json({ mailpieces: mailpieces() }) }).tracker.fetch(SHIPMENT))
      .rejects.toMatchObject({ message });
  });

  it("refuses an item detail of another item", async () => {
    const { detail } = outForDelivery();
    const app = tracker({ step: /\/detail$/, reply: () => Response.json({ ...detail, mailpieceId: '993412345699999981' }) });
    await expect(app.tracker.fetch(SHIPMENT)).rejects.toMatchObject({ message: 'Swiss Post returned a different shipment' });
  });

  it('keeps the summary, marked summary only, when the item detail fails or has no scans', async () => {
    const invalidKey = () => Response.json({ status: 404, title: 'Invalid mailpiece key' }, { status: 404 });
    for (const reply of [() => new Response('unavailable', { status: 500 }), invalidKey, () => new Response(OUTAGE_PAGE),
      () => Response.json({ mailpieceId: SHIPMENT })]) {
      await expect(tracker({ step: /\/detail$/, reply }).tracker.fetch(SHIPMENT)).resolves.toMatchObject({
        status: 'in_transit', current_stage: 'in_transit', global_status: 'ON_GOING_DELIVERY', canonical_tracking_number: SHIPMENT,
        last_status_text: 'ON_GOING_DELIVERY', last_update: '2026-09-12T08:00:00+02:00', expected_delivery: '2026-09-12 09:00–12:00',
        summary_only: true, events: [],
      });
    }
    const { summary } = outForDelivery();
    const keyless = tracker({ search: () => Response.json({ mailpieces: [{ ...summary, mailpieceKey: null }] }) });
    await expect(keyless.tracker.fetch(SHIPMENT)).resolves.toMatchObject({ summary_only: true });
    expect(keyless.calls).toHaveLength(1);
  });

  it('sends a call that hangs once more, inside the budget', async () => {
    fakeBudgetClock();
    const { detail, summary } = outForDelivery();
    const search = delayedFetcher([{ afterMs: Infinity }, { afterMs: 300, reply: () => Response.json({ mailpieces: [summary] }) }]);
    const fetcher: typeof fetch = async (input, init) => String(input).endsWith('/detail') ? Response.json(detail) : search.fetcher(input, init);
    const lookup = new SwissPostTracker({ fetcher }).fetch(SHIPMENT, { budgetMs: 12_000 });
    await vi.advanceTimersByTimeAsync(6_300);
    await expect(lookup).resolves.toMatchObject({ status: 'out_for_delivery' });
    // Half of the 12-second budget, then the retry within the rest.
    expect(search.ended).toEqual([6_000, 6_300]);
    expect(search.fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks in the reader's language when Swiss Post has it, else in English", async () => {
    const app = tracker();
    const { track } = adapter({ fetcher: app.fetcher } as AdapterEnvironment);
    for (const language of ['fr-CH', 'de', 'IT', 'es', null]) {
      // The stage comes from the code, whatever the wording.
      await expect(track({ number: SHIPMENT, language })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    }
    expect(app.calls.map((call) => call.language)).toEqual(['fr', 'fr', 'de', 'de', 'it', 'it', 'en', 'en', 'en', 'en']);
  });
});

describe('Swiss Post outage page', () => {
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
  const search = /\/compact\/\?/;

  it('reads it in place of the search as inconclusive, not as a malformed reply or a missing parcel', async () => {
    const app = tracker({ step: search, reply: () => html(OUTAGE_PAGE) });
    const error = await failure(app.tracker.fetch(SHIPMENT));
    expect(error).toBeInstanceOf(IndeterminateError);
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ kind: 'indeterminate', provider: 'Swiss Post', cause: expect.any(TypeError) });
    expect(carrierErrorKind(error)).toBe('indeterminate');
    // An answer, not a failure to reach Swiss Post: it is not asked again.
    expect(app.calls).toHaveLength(1);
  });

  it.each([
    ['the bare refresh', '<meta http-equiv="refresh" content="0; url=https://sorry.post.ch">'],
    ['upper case, single quotes, http and a trailing slash', `<META HTTP-EQUIV='Refresh' CONTENT='0;URL=http://sorry.post.ch/'>`],
    ['attributes swapped, extra whitespace and a quoted address', `<meta content="5 ;\n  url = 'https://SORRY.post.ch/'" http-equiv=" refresh ">`],
    ['unquoted attributes without url=', '<meta http-equiv=refresh content=0,https://sorry.post.ch/>'],
    ['the indented 2024 page', OUTAGE_PAGE.replace('2025', '2024').replaceAll('\t', '  ')],
  ])('knows it by its refresh to sorry.post.ch: %s', async (_, body) => {
    await expect(tracker({ step: search, reply: () => html(body) }).tracker.fetch(SHIPMENT)).rejects.toBeInstanceOf(IndeterminateError);
  });

  it.each([
    ['an unrelated page', '<html><body>sorry</body></html>'],
    ['a refresh to another host', '<meta http-equiv="refresh" content="0; url=https://sorry.post.ch.example.test">'],
    ['a refresh to another path', '<meta http-equiv="refresh" content="0; url=https://example.test/sorry.post.ch">'],
    ['a refresh to a page of the outage site', '<meta http-equiv="refresh" content="0; url=https://sorry.post.ch/other">'],
    ['a link to the outage site', '<html><body><a href="https://sorry.post.ch">sorry</a></body></html>'],
    ['a named meta, not a refresh', '<meta name="refresh" content="0; url=https://sorry.post.ch">'],
  ])('keeps %s a malformed reply', async (_, body) => {
    const error = await failure(tracker({ step: search, reply: () => html(body) }).tracker.fetch(SHIPMENT));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: 'Swiss Post returned an invalid tracking response' });
  });

  it.each([404, 410])('reads a search answering HTTP %i as a moved service, not a missing parcel', async (status) => {
    const app = tracker({ step: search, reply: () => new Response('Not Found', { status }) });
    const error = await failure(app.tracker.fetch(SHIPMENT));
    expect(error).not.toBeInstanceOf(NotFoundError);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'transport', message: 'Swiss Post no longer serves this tracking call' });
    expect(carrierErrorKind(error)).toBe('transport');
  });

  it('keeps the HTTP 502 it comes with when the backend is degraded', async () => {
    const error = await failure(tracker({ step: search, reply: () => html(OUTAGE_PAGE, 502) }).tracker.fetch(SHIPMENT));
    expect(error).toBeInstanceOf(UpstreamHttpError);
    expect(error).toMatchObject({ kind: 'indeterminate', status: 502 });
  });

  const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } });

  it.each([
    ['in English', 'https://www.post.ch/en/pages/maintenance'],
    ['in German', 'https://www.post.ch/de/pages/maintenance/'],
  ])('reads a redirect to the maintenance page, %s, as maintenance, asked once', async (_, location) => {
    const app = tracker({ step: search, reply: redirect(location) });
    const error = await failure(app.tracker.fetch(SHIPMENT));
    expect(error).toBeInstanceOf(MaintenanceError);
    expect(error).toMatchObject({ kind: 'maintenance', provider: 'Swiss Post' });
    expect(app.calls).toHaveLength(1);
  });

  it.each([
    ['another page of the site', 'https://www.post.ch/en/pages/other'],
    ['the maintenance path on another host', 'https://example.test/en/pages/maintenance'],
    ['no address', ''],
  ])('reads a redirect to %s as no tracking answer', async (_, location) => {
    const error = await failure(tracker({ step: search, reply: redirect(location, 301) }).tracker.fetch(SHIPMENT));
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ kind: 'transport', message: 'Swiss Post redirected its tracking service' });
  });
});

it('reports a refused parcel as an exception during ongoing delivery', () => {
  const result = parseSwissPostShipment(item({ status: { status: 'ON_GOING_DELIVERY' } }), [
    scan('3700', '2026-09-10T07:00:00+02:00', { title: 'The recipient has refused delivery' }),
  ]);
  expect(result).toMatchObject({ status: 'exception', current_stage: 'exception' });
});

it('reads nested formatting once in a scan title and headline', () => {
  const result = parseSwissPostShipment(item(), [scan('4000', '2026-09-10T07:00:00+02:00', {
    title: 'Item <span><strong>delivered</strong></span>',
  })]);
  expect(result.last_status_text).toBe('Item delivered');
  expect(result.events?.[0]?.description).toBe('Item delivered');
});
