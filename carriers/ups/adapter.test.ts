import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { IndeterminateError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { UPSTracker, parseUPSTrackingHtml, parseUPSTrackingResponse, upsTrackingUrl } from './adapter.js';
import statuses from './statuses.json' with { type: 'json' };
import { UPS_PROGRESS_STATUS, upsActivityStage, upsStatus } from './status.js';

// 1Z999AA10123456784 is a made-up number in UPS's published format; it is the
// same value numbers.json records as synthetic. No real shipment, recipient or
// session cookie appears in this file.
const TRACKING_NUMBER = '1Z999AA10123456784';
// The same number with a check digit that does not match.
const BAD_CHECK_DIGIT = '1Z999AA10123456785';
// A made-up 26-digit USPS package number with a valid check digit.
const POSTAL_PIC = '92612900000000000000123454';
const STATUS_API = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
const TRAWL_URL = 'http://trawl.internal:8191';
const OUT_FOR_DELIVERY = JSON.parse(
  readFileSync(new URL('./fixtures/out-for-delivery.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;
// The day the fixture's scans happen on, so the year-less scheduled delivery
// date resolves without rolling into the next year.
const TODAY = new Date('2026-08-04T06:00:00Z');
/** UPS's successful reply for a number it has no record of: expired, or not active yet. */
const UNKNOWN_NUMBER = JSON.stringify({
  statusCode: '200', statusText: 'Successful',
  trackDetails: [{
    errorCode: '504', errorText: 'Tracking number not found in database',
    requestedTrackingNumber: TRACKING_NUMBER, trackingNumber: TRACKING_NUMBER,
  }],
});
/** A successful reply whose parcel carries one of the error codes UPS's page reads as an outage. */
function outage(errorCode: string, trackingNumber?: string): string {
  return JSON.stringify({
    statusCode: '200', statusText: 'Successful',
    trackDetails: [{ errorCode, errorText: 'Example outage text', ...(trackingNumber ? { trackingNumber } : {}) }],
  });
}
const RENDERED_PAGE = `
  <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
  <body>
    <span id="stApp_nameKey">Delivered <span>check_circle</span></span>
    <p id="stApp_deliveredToAddress">ZUERICH CH</p>
  </body></html>
`;

function fixture(): Record<string, unknown> {
  return structuredClone(OUT_FOR_DELIVERY);
}

/** One synthetic scan; `utc` is the UTC pair UPS sends as `gmtDate` / `gmtTime`. */
function scan(actCode: string, activityScan: string, utc: string | null, location = 'EXAMPLE CITY, DE'): Record<string, unknown> {
  return {
    actCode, activityScan, location,
    ...(utc ? { gmtDate: utc.slice(0, 8), gmtTime: utc.slice(9), gmtOffset: '+02:00' } : {}),
  };
}

/** The fixture's parcel with other scans and package fields. */
function withScans(activities: Record<string, unknown>[], detail: Record<string, unknown> = {}): Record<string, unknown> {
  const payload = fixture();
  const [first] = payload.trackDetails as Record<string, unknown>[];
  Object.assign(first!, { scheduledDeliveryDateDetail: null, shipmentProgressActivities: activities }, detail);
  return payload;
}

const ACCESS_POINT = {
  locationType: 'Retail store',
  location: {
    companyName: 'EXAMPLE KIOSK',
    attentionName: 'PRIVATE ATTENTION NAME',
    streetAddress1: 'EXAMPLESTR. 1',
    streetAddress2: '',
    streetAddress3: '',
    city: 'EXAMPLE CITY',
    state: '',
    province: '',
    zipCode: '00000',
    country: 'DE',
  },
  dailyHoursOfOperations: { Monday: 'PRIVATE HOURS' },
  geoLatitude: '1.2345',
  geoLongitude: '2.3456',
};
const KIOSK = 'EXAMPLE KIOSK\nEXAMPLESTR. 1\n00000 EXAMPLE CITY';

function stepRecorder(): { recorder: StepRecorder; records: string[] } {
  const records: string[] = [];
  return {
    records,
    recorder: {
      step: (record) => records.push(`${record.step}:${record.outcome}`),
      lookup: (record) => records.push(`lookup:${record.finalStep}:${record.outcome}`),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('UPS status vocabulary', () => {
  it('maps every activity code statuses.json records, and nothing else', () => {
    const codes = statuses.entries.flatMap((entry) => 'code' in entry && /^[0-9A-Z]{2}$/.test(entry.code ?? '')
      ? [{ code: entry.code!, stage: entry.stage }] : []);
    expect(codes.length).toBeGreaterThan(30);
    for (const { code, stage } of codes) expect(upsActivityStage(code), code).toBe(stage);
    for (const code of ['', 'XX', 'constructor', 'toString', '__proto__']) expect(upsActivityStage(code)).toBeUndefined();
  });

  it('maps the progress token, the prose, and nothing else', () => {
    expect(UPS_PROGRESS_STATUS.outfordelivery).toBe('out_for_delivery');
    expect(UPS_PROGRESS_STATUS.manifestupload).toBe('pending');
    expect(upsStatus('Returned to Sender')).toBe('exception');
    expect(upsStatus('Your package was left at the front door')).toBe('delivered');
    expect(upsStatus('Label Created')).toBe('pending');
    // Unrecognized wording only means "moving" once the shipment has scans.
    expect(upsStatus('Wording UPS has not used before')).toBe('unknown');
    expect(upsStatus('Wording UPS has not used before', true)).toBe('in_transit');
  });
});

describe('UPS structured response', () => {
  it('accepts scalar success codes and rejects structured codes', () => {
    expect(parseUPSTrackingResponse({ ...fixture(), statusCode: 200 }, TRACKING_NUMBER, TODAY).status).toBe('out_for_delivery');
    for (const statusCode of [[200], { value: 200 }]) {
      expect(() => parseUPSTrackingResponse({ ...fixture(), statusCode }, TRACKING_NUMBER, TODAY)).toThrow(IndeterminateError);
    }
  });

  it('projects the scan history and prefers the UTC pair for each scan', () => {
    const result = parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY);
    expect(result).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'out_for_delivery',
      current_stage_source: 'carrier_map',
      last_status_text: 'Out For Delivery Today',
      last_update: '2026-08-04T07:12:04+00:00',
      expected_delivery: '2026-08-04',
      destination_country: 'CH',
    });
    const mapped = { stage_source: 'carrier_map' };
    expect(result.events).toEqual([
      {
        time: '2026-08-04T07:12:04+00:00', location: 'ZUERICH, CH', description: 'Out For Delivery Today',
        provider_code: 'OT', stage: 'out_for_delivery', ...mapped,
      },
      {
        time: '2026-08-04T03:03:51+00:00', location: 'ZUERICH, CH', description: 'Arrived at Facility',
        provider_code: 'AR', stage: 'in_transit', ...mapped,
      },
      {
        time: '2026-08-03T21:41:10+00:00',
        location: 'KOELN, DE',
        description: 'Departed from Facility — Your package is on the way',
        provider_code: 'DP', stage: 'in_transit', ...mapped,
      },
    ]);
  });

  it('lets the newest scan code outrank the progress token', () => {
    // A Ground Saver delay: UPS's token reads Exception, the parcel is moving.
    const delayed = parseUPSTrackingResponse(withScans([
      scan('ZW', 'Package moving to local post office', '20260806 15:50:00'),
      scan('Q5', 'We&#39;re sorry this package may experience a temporary delay.', '20260805 19:22:00'),
      scan('MP', 'Shipper created a label, UPS has not received the package yet. ', null, 'United States'),
    ], { progressBarType: 'Exception', packageStatus: 'Update' }), TRACKING_NUMBER, TODAY);
    expect(delayed).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', expected_delivery: null });
    expect(delayed.events?.map((event) => [event.provider_code, event.stage])).toEqual([
      ['ZW', 'in_transit'], ['Q5', 'in_transit'], ['MP', 'registered'],
    ]);
    expect(delayed.events?.[1]?.description).toBe("We're sorry this package may experience a temporary delay.");
    expect(delayed.delivered_at).toBeUndefined();

    // A failed attempt is not a delivery, whatever the token says.
    expect(parseUPSTrackingResponse(withScans([
      scan('G3', 'We tried to deliver to the business, but it was closed.', '20260903 16:21:12'),
      scan('OT', 'Out For Delivery Today', '20260903 07:26:42'),
    ], { progressBarType: 'OutForDelivery' }), TRACKING_NUMBER, TODAY))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });

    // A code the map does not know leaves the stage to the shared classifier.
    const unmapped = parseUPSTrackingResponse(withScans([
      scan('X9', 'Wording UPS has not used before', '20260806 15:50:00'),
      scan('AR', 'Arrived at Facility', '20260806 10:00:00'),
    ], { progressBarType: 'InTransit' }), TRACKING_NUMBER, TODAY);
    expect(unmapped).toMatchObject({ status: 'in_transit' });
    expect(unmapped.current_stage).toBeUndefined();
    expect(unmapped.events?.[0]).toEqual({
      time: '2026-08-06T15:50:00+00:00', location: 'EXAMPLE CITY, DE',
      description: 'Wording UPS has not used before', provider_code: 'X9',
    });
  });

  it('names the access point and its address only while the parcel waits there', () => {
    const waiting = parseUPSTrackingResponse(withScans([
      scan('ZP', 'UPS Access Point&#8482; possession ', '20260811 09:22:52'),
      scan('2Q', 'Delivered to UPS Access Point&#8482; ', '20260811 09:22:39'),
      scan('ZC', 'The package will be delivered to the UPS Access Point&#8482; location requested by the receiver.', '20260810 16:22:20'),
    ], { progressBarType: 'Delivered', upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(waiting).toMatchObject({
      status: 'out_for_delivery',
      current_stage: 'ready_for_pickup',
      pickup_point: KIOSK,
      last_status_text: 'UPS Access Point™ possession',
    });
    expect(waiting.delivered_at).toBeUndefined();
    expect(waiting.events?.map((event) => event.stage)).toEqual(['ready_for_pickup', 'ready_for_pickup', 'in_transit']);

    const collected = parseUPSTrackingResponse(withScans([
      scan('2W', 'DELIVERED ', '20260811 10:14:47'),
      scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52'),
    ], { progressBarType: 'Delivered', upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(collected).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-08-11T10:14:47+00:00', expected_delivery: null,
    });
    expect(collected.pickup_point).toBeUndefined();

    // A suggested access point on a parcel still on its way is not a pickup point.
    const suggested = parseUPSTrackingResponse(withScans([scan('AR', 'Arrived at Facility', '20260806 10:00:00')],
      { upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY);
    expect(suggested.pickup_point).toBeUndefined();
    // Without a business name the point stays unnamed: the attention name can be a person's.
    const unnamed = parseUPSTrackingResponse(withScans([scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52')],
      { upsAccessPoint: { ...ACCESS_POINT, location: { ...ACCESS_POINT.location, companyName: '' } } }), TRACKING_NUMBER, TODAY);
    expect(unnamed).toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(unnamed.pickup_point).toBeUndefined();
    for (const result of [waiting, collected, suggested, unnamed]) {
      const serialized = JSON.stringify(result);
      for (const value of ['PRIVATE', '1.2345', '2.3456']) expect(serialized).not.toContain(value);
    }
  });

  it('lays out the access point address as UPS gives it, and keeps the name alone without a street or town', () => {
    const point = (location: Record<string, string>) => parseUPSTrackingResponse(withScans(
      [scan('ZP', 'UPS Access Point™ possession ', '20260811 09:22:52')],
      { upsAccessPoint: { ...ACCESS_POINT, location: { ...ACCESS_POINT.location, ...location } } }), TRACKING_NUMBER, TODAY).pickup_point;
    expect(point({ streetAddress2: 'EXAMPLE MALL', streetAddress3: 'UNIT 2' }))
      .toBe('EXAMPLE KIOSK\nEXAMPLESTR. 1\nEXAMPLE MALL, UNIT 2\n00000 EXAMPLE CITY');
    expect(point({ streetAddress1: '1 EXAMPLE ST', city: 'EXAMPLETOWN', state: 'GA', zipCode: '00000', country: 'US' }))
      .toBe('EXAMPLE KIOSK\n1 EXAMPLE ST\nEXAMPLETOWN, GA 00000');
    expect(point({ streetAddress1: '&#49; EXAMPLE ST', zipCode: '' })).toBe('EXAMPLE KIOSK\n1 EXAMPLE ST\nEXAMPLE CITY');
    expect(point({ streetAddress1: '' })).toBe('EXAMPLE KIOSK');
    expect(point({ city: '' })).toBe('EXAMPLE KIOSK');
  });

  it('keeps scans without a UTC pair on the clock UPS gives, and none when it gives none', () => {
    const result = parseUPSTrackingResponse(withScans([
      { actCode: 'AR', activityScan: 'Arrived at Facility', date: '08/04/2026', time: '12:05 P.M.', gmtOffset: '+02:00' },
      { actCode: 'DP', activityScan: 'Departed from Facility', date: '08/04/2026', time: '12:41 A.M.' },
      { actCode: 'XD', activityScan: 'Drop-Off', date: '08/03/2026' },
      { actCode: 'MP', activityScan: 'Shipper created a label, UPS has not received the package yet. ' },
    ]), TRACKING_NUMBER, TODAY);
    expect(result.events?.map(({ time, local_time, provider_time_text }) => ({ time, local_time, provider_time_text }))).toEqual([
      { time: '2026-08-04T12:05:00+02:00', local_time: undefined, provider_time_text: undefined },
      { time: undefined, local_time: '2026-08-04T00:41:00', provider_time_text: undefined },
      { time: undefined, local_time: undefined, provider_time_text: '08/03/2026' },
      { time: undefined, local_time: undefined, provider_time_text: undefined },
    ]);
    expect(result.events?.every((event) => !('time' in event) || event.time)).toBe(true);
    expect(resolveResult(result).events.map((event) => event.instant)).toEqual(['2026-08-04T12:05:00+02:00', null, null, null]);

    const labelOnly = parseUPSTrackingResponse(withScans([
      { actCode: 'MP', activityScan: 'Shipper created a label, UPS has not received the package yet. ' },
    ], { progressBarType: 'ManifestUpload' }), TRACKING_NUMBER, TODAY);
    expect(labelOnly).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
  });

  it('reports a number UPS refuses for its check digit as invalid input', () => {
    const refused = { statusCode: '402', statusText: 'Invalid Request', trackDetails: null };
    expect(() => parseUPSTrackingResponse(refused, BAD_CHECK_DIGIT)).toThrow(InvalidInputError);
    // A number that passes the check proves nothing by a refusal.
    expect(() => parseUPSTrackingResponse(refused, TRACKING_NUMBER)).toThrow(IndeterminateError);
  });

  it('reports a number UPS has no record of as not found, and only that error', () => {
    const unknown = JSON.parse(UNKNOWN_NUMBER) as { trackDetails: Record<string, unknown>[] };
    expect(() => parseUPSTrackingResponse(unknown, TRACKING_NUMBER)).toThrow(NotFoundError);
    // An error that does not name the number, or another code, keeps the old reading.
    const unnamed = structuredClone(unknown);
    unnamed.trackDetails = [{ errorCode: '504', errorText: 'Tracking number not found in database' }];
    expect(parseUPSTrackingResponse(unnamed, TRACKING_NUMBER)).toMatchObject({ status: 'unknown', events: [] });
    const other = structuredClone(unknown);
    Object.assign(other.trackDetails[0]!, { errorCode: '505', errorText: 'Example error text' });
    expect(parseUPSTrackingResponse(other, TRACKING_NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Example error text' });
  });

  it('reports the codes UPS reads as an outage as inconclusive, whichever number the reply names', () => {
    const thrown = (payload: unknown): unknown => {
      try {
        parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const code of ['298', '299']) {
      const unavailable = { name: 'UPSUnavailableError', kind: 'indeterminate', message: `UPS tracking is temporarily unavailable (error ${code})` };
      expect(thrown({ statusCode: code, statusText: 'Example outage text' })).toMatchObject(unavailable);
      for (const payload of [outage(code, TRACKING_NUMBER), outage(code), outage(code, '1Z999AA10123456793')]) {
        const error = thrown(JSON.parse(payload));
        expect(error).toBeInstanceOf(IndeterminateError);
        expect(error).toMatchObject(unavailable);
      }
    }
  });

  it('keeps the recipient block out of the result', () => {
    const serialized = JSON.stringify(parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY));
    for (const value of [
      'PRIVATE RECIPIENT', '10 PRIVATE STREET', 'PRIVATE CITY', 'PRIVATE POSTCODE',
      'PRIVATE-SIGNATURE-LINK', 'PRIVATE-PHOTO-LINK', 'receivedBy', 'signatureLink',
    ]) {
      expect(serialized).not.toContain(value);
    }
  });

  it('names the shipping service without its trademark signs', () => {
    const payload = fixture();
    const [detail] = payload.trackDetails as Record<string, unknown>[];
    expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY)).not.toHaveProperty('service_name');
    for (const [serviceName, name] of [['UPS Standard&#174;', 'UPS Standard'], ['UPS Express™ 12:00', 'UPS Express 12:00'],
      ['UPS Ground', 'UPS Ground']]) {
      detail!.additionalInformation = { serviceInformation: { serviceName, serviceLink: null, serviceAttribute: null } };
      expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY).service_name).toBe(name);
    }
    for (const serviceInformation of [null, { serviceName: '&#174;' }, { serviceName: 7 }]) {
      detail!.additionalInformation = { serviceInformation };
      expect(parseUPSTrackingResponse(payload, TRACKING_NUMBER, TODAY)).not.toHaveProperty('service_name');
    }
  });

  it('names the USPS number of a parcel handed to the post office, and nothing that is not one', () => {
    const handedOver = (postalServiceTrackingID: unknown) => withScans([
      scan('YC', 'Package delivered by local post office ', '20260804 15:10:00', 'EXAMPLE TOWN, NY, US'),
      scan('YH', 'Received by the local post office', '20260804 07:30:00', 'EXAMPLE TOWN, NY, US'),
      scan('LX', 'Package transferred to post office', '20260803 22:05:00', 'EXAMPLE CITY, NY, US'),
    ], { additionalInformation: { serviceInformation: { serviceName: 'UPS Ground Saver&#174;' }, postalServiceTrackingID } });
    const result = parseUPSTrackingResponse(handedOver(POSTAL_PIC), TRACKING_NUMBER, TODAY);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', delivered_at: '2026-08-04T15:10:00+00:00',
      service_name: 'UPS Ground Saver', delivery_carrier: 'usps', delivery_tracking_number: POSTAL_PIC,
    });
    expect(result.events?.map((event) => [event.provider_code, event.stage])).toEqual([['YC', 'delivered'], ['YH', 'in_transit'], ['LX', 'in_transit']]);
    expect(deliveryHandoff('ups', TRACKING_NUMBER, resolveResult(result))).toEqual({ carrier: 'usps', number: POSTAL_PIC, basis: 'partner' });
    // A routing barcode keeps only the package number after its ZIP code.
    expect(parseUPSTrackingResponse(handedOver(`42000000${POSTAL_PIC}`), TRACKING_NUMBER, TODAY).delivery_tracking_number).toBe(POSTAL_PIC);
    for (const id of [null, undefined, '', `${POSTAL_PIC.slice(0, -1)}5`, TRACKING_NUMBER, 'NOT AVAILABLE', { id: POSTAL_PIC }]) {
      const dropped = parseUPSTrackingResponse(handedOver(id), TRACKING_NUMBER, TODAY);
      expect(dropped).not.toHaveProperty('delivery_carrier');
      expect(dropped).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('produces every capability carrier.json declares', () => {
    const result = parseUPSTrackingResponse(fixture(), TRACKING_NUMBER, TODAY);
    expect(CAPABILITIES).toEqual(['history', 'location', 'eta', 'delivered_at', 'pickup_point', 'provider_code', 'service_name',
      'delivery_partner', 'delivery_tracking_number']);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.events?.every((event) => event.provider_code)).toBe(true);
    expect(result.expected_delivery).toBeTruthy();
    expect(parseUPSTrackingResponse(withScans([scan('KB', 'DELIVERED ', '20260804 10:28:15')]), TRACKING_NUMBER, TODAY)
      .delivered_at).toBe('2026-08-04T10:28:15+00:00');
    expect(parseUPSTrackingResponse(withScans([scan('2Q', 'Delivered to UPS Access Point™ ', '20260804 10:28:15')],
      { upsAccessPoint: ACCESS_POINT }), TRACKING_NUMBER, TODAY).pickup_point).toBe(KIOSK);
    const served = fixture();
    Object.assign((served.trackDetails as Record<string, unknown>[])[0]!, { additionalInformation: { serviceInformation: { serviceName: 'UPS Ground' } } });
    expect(parseUPSTrackingResponse(served, TRACKING_NUMBER, TODAY).service_name).toBe('UPS Ground');
    const handed = fixture();
    Object.assign((handed.trackDetails as Record<string, unknown>[])[0]!, { additionalInformation: { postalServiceTrackingID: POSTAL_PIC } });
    expect(parseUPSTrackingResponse(handed, TRACKING_NUMBER, TODAY))
      .toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: POSTAL_PIC });
  });

  it('fails closed on another parcel and reports an unavailable API as inconclusive', () => {
    const other = fixture();
    (other.trackDetails as Record<string, unknown>[])[0]!.trackingNumber = '1Z999AA10123456793';
    expect(() => parseUPSTrackingResponse(other, TRACKING_NUMBER, TODAY))
      .toThrow('UPS did not return the requested parcel');
    expect(() => parseUPSTrackingResponse({ statusCode: '500', statusText: 'Unavailable' }, TRACKING_NUMBER))
      .toThrow('Unavailable');
    expect(() => parseUPSTrackingResponse('not an object', TRACKING_NUMBER))
      .toThrow('UPS returned an invalid tracking response');
  });
});

describe('UPS lookup steps', () => {
  it('reports the missing browser service when the direct session is challenged', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('<html>challenge</html>', { status: 403 }));
    const { recorder, records } = stepRecorder();

    await expect(new UPSTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: '',
      recorder,
    }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'ChallengeError',
      status: 403,
      message: 'UPS challenged direct tracking; configure FLARESOLVERR_URL for browser fallback',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('ups.com/track');
    expect(records).toEqual(['direct:challenge', 'lookup:direct:challenge']);
  });

  it('reads the status reply the browser captured instead of replaying its cookies', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2,
      statusCode: 200,
      url: upsTrackingUrl(TRACKING_NUMBER),
      html: RENDERED_PAGE,
      cookies: [{ name: 'X-XSRF-TOKEN-ST', value: 'token', domain: '.ups.com', path: '/' }],
      userAgent: 'Mozilla/5.0 (test browser)',
      capturedResponses: [
        { url: STATUS_API, status: 200, headers: {}, body: null, truncated: false, base64Encoded: false, error: 'unreadable' },
        { url: STATUS_API, status: 200, headers: {}, body: JSON.stringify(fixture()), truncated: false, base64Encoded: false, error: null },
      ],
    }));
    const { recorder, records } = stepRecorder();

    const result = await new UPSTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL, recorder }).fetch(TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'out_for_delivery',
      tracking_source: 'structured-web-response',
      tracking_url: upsTrackingUrl(TRACKING_NUMBER),
    });
    expect(result.events?.length ?? 0).toBeGreaterThan(1);
    // One browser call and nothing else: no direct session, no cookie replay.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${TRAWL_URL}/scrape`);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: upsTrackingUrl(TRACKING_NUMBER),
      skipHttp: true,
      maxTier: 3,
      captureResponses: [STATUS_API],
    });
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it('falls back to the page the browser rendered when no status reply was captured', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tier: 3,
        statusCode: 200,
        url: upsTrackingUrl(TRACKING_NUMBER),
        html: RENDERED_PAGE,
        cookies: [],
        userAgent: 'Mozilla/5.0 (test browser)',
        capturedResponses: [
          { url: STATUS_API, status: 200, headers: {}, body: 'not json', truncated: false, base64Encoded: false, error: null },
        ],
      }), { headers: { 'Content-Type': 'application/json' } }));
    const { recorder, records } = stepRecorder();

    const result = await new UPSTracker({
      timeoutMs: 2_000,
      directTimeoutMs: 1_000,
      trawlUrl: 'http://trawl.internal:8191/v1',
      recorder,
    }).fetch(TRACKING_NUMBER);

    expect(result).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      tracking_source: 'rendered-page',
      tracking_url: upsTrackingUrl(TRACKING_NUMBER),
      events: [{ location: 'ZUERICH CH' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://trawl.internal:8191/scrape');
    expect(records).toEqual(['trawl:ok', 'lookup:trawl:ok']);
  });

  it('reports a refused check digit from either tier instead of a challenge', async () => {
    const refused = JSON.stringify({ statusCode: '402', statusText: 'Invalid Request', trackDetails: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(BAD_CHECK_DIGIT), html: RENDERED_PAGE, cookies: [],
      capturedResponses: [{ url: STATUS_API, status: 200, headers: {}, body: refused, truncated: false, base64Encoded: false, error: null }],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL }).fetch(BAD_CHECK_DIGIT))
      .rejects.toMatchObject({ name: 'InvalidInputError', kind: 'invalid_input' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(refused, { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(BAD_CHECK_DIGIT))
      .rejects.toMatchObject({ name: 'InvalidInputError', kind: 'invalid_input' });
    expect(records).toEqual(['direct:invalid_input', 'lookup:direct:invalid_input']);
  });

  it('reports a number UPS has no record of from either tier, without reading the page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [],
      capturedResponses: [{ url: STATUS_API, status: 200, headers: {}, body: UNKNOWN_NUMBER, truncated: false, base64Encoded: false, error: null }],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', kind: 'not_found' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(UNKNOWN_NUMBER, { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', kind: 'not_found' });
    expect(records).toEqual(['direct:not_found', 'lookup:direct:not_found']);
  });

  it('reports an outage from either tier instead of the rendered page or a challenge', async () => {
    const unavailable = { name: 'UPSUnavailableError', kind: 'indeterminate' };
    // The page the browser rendered reads "Delivered"; it must not hide the outage.
    for (const captured of [
      { url: STATUS_API, status: 200, headers: {}, body: outage('299', TRACKING_NUMBER), truncated: false, base64Encoded: false, error: null },
      { url: STATUS_API, status: 200, headers: {}, body: JSON.stringify({ statusCode: '298' }), truncated: false, base64Encoded: false, error: null },
    ]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
        tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [], capturedResponses: [captured],
      }));
      await expect(new UPSTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL }).fetch(TRACKING_NUMBER)).rejects.toMatchObject(unavailable);
    }
    // An HTTP 428 is the firewall's challenge, not an outage: the rendered page still answers.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tier: 2, statusCode: 200, url: upsTrackingUrl(TRACKING_NUMBER), html: RENDERED_PAGE, cookies: [], capturedResponses: [
        { url: STATUS_API, status: 428, headers: {}, body: '', truncated: false, base64Encoded: false, error: null },
      ],
    }));
    await expect(new UPSTracker({ timeoutMs: 2_000, trawlUrl: TRAWL_URL }).fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'rendered-page' });

    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url) === STATUS_API) return new Response(outage('299', TRACKING_NUMBER), { headers: { 'Content-Type': 'application/json' } });
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const { recorder, records } = stepRecorder();
    await expect(new UPSTracker({ trawl: null, fetcher, recorder }).fetch(TRACKING_NUMBER)).rejects.toMatchObject(unavailable);
    expect(records).toEqual(['direct:indeterminate', 'lookup:direct:indeterminate']);
  });

  it('rejects a number that is not a UPS number before any request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not fetch'));
    const lookup = new UPSTracker({ trawlUrl: '' }).fetch('1Z999');
    await expect(lookup).rejects.toThrow('UPS tracking numbers must start with 1Z');
    await expect(lookup).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('UPS lookup context', () => {
  /** A request that ends only when its signal aborts. */
  const held = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error), { once: true });
  });

  it('answers a caller cancelled in the queue at once and leaves the next caller its turn', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce((_url, init) => held(init))
      .mockImplementation(async () => Response.json({ tier: 3, statusCode: 200, html: RENDERED_PAGE, cookies: [] }));
    const tracker = new UPSTracker({ trawlUrl: TRAWL_URL, fetcher });
    const first = new AbortController();
    const second = new AbortController();
    const running = tracker.fetch(TRACKING_NUMBER, { signal: first.signal });
    const queued = tracker.fetch(TRACKING_NUMBER, { signal: second.signal });
    const next = tracker.fetch(TRACKING_NUMBER);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    second.abort(new Error('second caller left'));
    await expect(queued).rejects.toThrow('second caller left');

    first.abort(new Error('first caller left'));
    await expect(running).rejects.toThrow('first caller left');
    await expect(next).resolves.toMatchObject({ status: 'delivered' });
    // The cancelled turn passed without a request of its own.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('ends a queued lookup when the budget its caller set is spent', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => held(init));
    const tracker = new UPSTracker({ trawlUrl: TRAWL_URL, fetcher });
    const first = new AbortController();
    const running = tracker.fetch(TRACKING_NUMBER, { signal: first.signal });

    await expect(tracker.fetch(TRACKING_NUMBER, { budgetMs: 40 }))
      .rejects.toMatchObject({ name: 'BudgetExceededError', kind: 'budget' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    first.abort(new Error('first caller left'));
    await expect(running).rejects.toThrow('first caller left');
  });

  it('reports a browser service that outlasts the budget as a transport failure', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => held(init));
    const { recorder, records } = stepRecorder();

    await expect(new UPSTracker({ trawlUrl: TRAWL_URL, fetcher, recorder }).fetch(TRACKING_NUMBER, { budgetMs: 50 }))
      .rejects.toMatchObject({ name: 'UpstreamNetworkError', kind: 'transport' });
    expect(records).toEqual(['trawl:transport', 'lookup:trawl:transport']);
  });

  // The conformance test always configures a browser service, so it never runs this tier.
  it('bounds the plain HTTP tier by the budget and the signal without spoiling the next lookup', async () => {
    let answering = false;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url) === STATUS_API) return answering ? Response.json(fixture()) : held(init);
      const page = new Response(RENDERED_PAGE, { headers: { 'Set-Cookie': 'X-XSRF-TOKEN-ST=token; Domain=ups.com; Path=/' } });
      Object.defineProperty(page, 'url', { value: String(url) });
      return page;
    });
    const tracker = new UPSTracker({ trawl: null, fetcher });

    // A spent budget ends the held status call; the page already fetched still answers.
    await expect(tracker.fetch(TRACKING_NUMBER, { budgetMs: 50 }))
      .resolves.toMatchObject({ tracking_source: 'rendered-page' });

    const controller = new AbortController();
    const cancelled = tracker.fetch(TRACKING_NUMBER, { signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    controller.abort(new Error('caller left'));
    await expect(cancelled).rejects.toThrow('caller left');

    answering = true;
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    await expect(tracker.fetch(TRACKING_NUMBER)).resolves.toMatchObject({ tracking_source: 'structured-web-response' });
    // Neither unfinished session was kept; the one that answered serves the last lookup alone.
    expect(fetcher.mock.calls.map(([url]) => String(url) === STATUS_API))
      .toEqual([false, true, false, true, false, true, true]);
  });
});

describe('UPS rendered page', () => {
  it('verifies the requested number before reading the status banner', () => {
    expect(parseUPSTrackingHtml(RENDERED_PAGE, TRACKING_NUMBER)).toMatchObject({
      status: 'delivered',
      last_status_text: 'Delivered',
      events: [{ location: 'ZUERICH CH' }],
    });
    expect(() => parseUPSTrackingHtml('<body>another parcel</body>', TRACKING_NUMBER))
      .toThrow('UPS did not return the requested parcel');
  });

  it('never places the banner in the ship-to town', () => {
    const result = parseUPSTrackingHtml(`
      <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
      <body>
        <span id="stApp_nameKey">On the Way</span>
        <p id="stApp_txtAddress">PRIVATE CITY</p><p id="stApp_txtCountry">DE</p>
      </body></html>`, TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', events: [{ description: 'On the Way' }] });
    expect(result.events?.[0]?.location).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('stages the banner by the milestone it names, the one scan without an activity code', () => {
    const banner = (name: string) => parseUPSTrackingHtml(`
      <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
      <body><span id="stApp_nameKey">${name}</span></body></html>`, TRACKING_NUMBER).events?.[0];
    expect(parseUPSTrackingHtml(RENDERED_PAGE, TRACKING_NUMBER).events?.[0]).toMatchObject({ description: 'Delivered', stage: 'delivered' });
    expect(banner('Label Created')).toMatchObject({ stage: 'registered' });
    expect(banner('On the Way')).toMatchObject({ stage: 'in_transit' });
    expect(banner('Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    // Other wording keeps no stage, and the banner never carries a code.
    expect(banner('Delivery Attempted')).toMatchObject({ description: 'Delivery Attempted' });
    expect(banner('Delivery Attempted')?.stage).toBeUndefined();
    expect(banner('Delivered')).not.toHaveProperty('provider_code');
  });
});

it('never opens a plain HTTP session while a browser service is configured', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('/scrape')
    ? Response.json({ tier: 3, statusCode: 200, html: RENDERED_PAGE, cookies: [] })
    : new Response('challenge', { status: 403 }));
  const tracker = new UPSTracker({ trawlUrl: TRAWL_URL });
  await tracker.fetch(TRACKING_NUMBER);
  await tracker.fetch(TRACKING_NUMBER);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('ups.com'))).toHaveLength(0);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('/scrape'))).toHaveLength(2);
});

describe('UPS rendered progress bar', () => {
  const page = (nameKey: string) => `
    <html><head><meta name="stapp-tracknum" content="${TRACKING_NUMBER}"></head>
    <body>
      <span id="stApp_nameKey">${nameKey}</span>
      <ups-ac-progress-bar id="stApp_shpmtProgress">
        <ol><li class="progress-step active" aria-current="true"></li><li class="progress-step inactive"></li></ol>
        <ol>
          <li class="progress-step active" aria-current="true"><button class="step-label"><span>Label Created </span></button><span class="sr-only">active</span></li>
          <li class="progress-step inactive"><button class="step-label"><span>On the Way </span></button><span class="sr-only">inactive</span></li>
          <li class="progress-step inactive"><button class="step-label"><span>Out for Delivery </span></button><span class="sr-only">inactive</span></li>
        </ol>
      </ups-ac-progress-bar>
    </body></html>`;

  it('reads only the active milestone, not every milestone still ahead', () => {
    expect(parseUPSTrackingHtml(page('Label Created'), TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_status_text: 'Label Created',
    });
    expect(parseUPSTrackingHtml(page(''), TRACKING_NUMBER)).toMatchObject({
      status: 'pending',
      last_status_text: 'Label Created',
    });
  });
});
