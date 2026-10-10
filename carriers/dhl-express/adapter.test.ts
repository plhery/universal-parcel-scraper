import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamNetworkError } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DhlExpressTracker, normalizeNumber, parse, parseMobile, parseUnified } from './adapter.js';
import { SETTINGS_TTL_MS } from './mobile.js';
import { dhlExpressStage } from './status.js';

const number = '1234567891';
const payload = () => ({ results: [{ id: number, duplicate: false, hasDuplicateShipment: false,
  consigneeCountryCode: 'CA', signature: { signatory: 'PRIVATE', link: { url: 'https://example.invalid/private' } },
  checkpoints: [
    { description: 'Delivered', date: 'Monday, October 05, 2026', time: '15:06', location: 'EXAMPLE CITY - CANADA' },
    { description: 'Shipment is out with courier for delivery', date: 'Monday, October 05, 2026', time: '12:35' },
    { description: 'Shipment picked up', date: 'Friday, October 02, 2026', time: '17:18', location: 'EXAMPLE CITY - USA' },
  ] }] });
const unifiedPayload = () => ({ shipments: [{ id: number, service: 'express',
  destination: { address: { countryCode: 'CA', streetAddress: 'PRIVATE' } },
  details: { proofOfDelivery: 'https://example.invalid/private', consignee: 'PRIVATE', pieceIds: ['PRIVATE'] },
  status: { description: 'Delivered', statusCode: 'delivered', timestamp: '2026-10-05T15:06:00-04:00' },
  events: [
    { description: 'Delivered', statusCode: 'delivered', status: 'OK', timestamp: '2026-10-05T15:06:00-04:00', location: { address: { addressLocality: 'EXAMPLE CITY', streetAddress: 'PRIVATE' } } },
    { description: 'Shipment is out with courier for delivery', statusCode: 'transit', status: 'WC', timestamp: '2026-10-05T12:35:00-04:00' },
    { description: 'Shipment picked up', statusCode: 'transit', status: 'PU', timestamp: '2026-10-02T17:18:00-07:00' },
  ] }] });
const captured = (body: unknown = unifiedPayload(), status = 200, url = `https://www.dhl.com/utapi?trackingNumber=${number}`) => ({
  url, status, headers: {}, body: JSON.stringify(body), truncated: false, base64Encoded: false, error: null,
});
const environment = (fetcher: typeof fetch, trawl: TrawlClient | null = null) => ({ fetcher, trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null });
const settings = [{ name: 'api_awb_encryption', value: 'N' }];
const mobilePayload = () => payload().results.map((shipment) => ({ ...shipment, status: '',
  checkpoints: shipment.checkpoints.map((row, index) => ({ ...row, date: 'localized date', date_en: row.date, counter: 3 - index, pIds: ['PRIVATE'] })) }));
const mobileFetcher = (reply: unknown = mobilePayload(), configuration: unknown = settings) => vi.fn<typeof fetch>()
  .mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? reply : configuration)));

describe('DHL Express projection', () => {
  it('distinguishes a matching not-found envelope from malformed or foreign errors', () => {
    const missing = { errors: [{ id: number, code: 404, label: 'Not found' }] };
    expect(() => parse(missing, number)).toThrow(NotFoundError);
    expect(() => parse(missing, '1234567880')).toThrow(SchemaError);
    expect(() => normalizeNumber('1234567890')).toThrow(InvalidInputError);
  });
  it('binds the waybill, maps milestones and preserves facility-local clocks without recipient data', () => {
    const result = parse(payload(), number);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'CA',
      last_update: null, last_update_local: '2026-10-05T15:06:00', events: [
        { local_time: '2026-10-05T15:06:00', stage: 'delivered' },
        { local_time: '2026-10-05T12:35:00', stage: 'out_for_delivery' }, { local_time: '2026-10-02T17:18:00', stage: 'accepted' },
      ] });
    // A consumer reads an offset-less `time` in the catalog zone, which is UTC here.
    expect(result.events?.some((event) => 'time' in event)).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|signature|signatory/);
  });
  it('maps DHL checkpoints that end with their facility, and leaves other wording to the classifier', () => {
    expect([
      'Shipment information received',
      'Processed at EXAMPLE CITY - FRANCE',
      'Arrived at DHL Sort Facility EXAMPLE CITY - FRANCE',
      'Arrived at DHL Delivery Facility EXAMPLE CITY - FRANCE',
      'Shipment has departed from a DHL facility EXAMPLE CITY - FRANCE',
      'Clearance processing complete at EXAMPLE CITY - FRANCE',
    ].map(dhlExpressStage)).toEqual([
      { stage: 'registered', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
      { stage: 'in_transit', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
      { stage: 'in_transit', source: 'carrier_map' }, { stage: 'in_transit', source: 'carrier_map' },
    ]);
    expect(dhlExpressStage('Processed for clearance at EXAMPLE CITY - FRANCE').source).not.toBe('carrier_map');
    expect(dhlExpressStage('Customs clearance status updated. Note - The Customs clearance process is under way.'))
      .toEqual({ stage: 'customs', source: 'carrier_map' });
  });
  it('dates a scan where its location settles the facility zone', () => {
    const clock = (location: string, date = 'Monday, October 05, 2026') => {
      const data = payload();
      data.results[0]!.checkpoints = [{ description: 'Processed', date, time: '12:00', location }];
      const result = parse(data, number);
      const scan = result.events![0]!;
      expect(result.last_update).toBe(scan.time ?? null);
      expect('last_update_local' in result).toBe(!scan.time);
      return scan.time ?? `local ${String(scan.local_time)}`;
    };
    // The shapes DHL writes, with the offsets its public page gives those facilities.
    expect(clock('EXAMPLE CITY - FRANCE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE CITY - FRANCE', 'Monday, January 05, 2026')).toBe('2026-01-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - NETHERLANDS, THE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE-CITY - UK')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE HUB - Ohio - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY - New York - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE GATEWAY - California - USA')).toBe('2026-10-05T12:00:00-07:00');
    expect(clock('EXAMPLE CITY - VIRGINIA,VA - USA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY - ON - CANADA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE SERVICE AREA - ONTARIO - CANADA')).toBe('2026-10-05T12:00:00-04:00');
    expect(clock('EXAMPLE CITY, CA - USA')).toBe('2026-10-05T12:00:00-07:00');
    // DHL's own names for countries.
    expect(clock("EXAMPLE CITY - THE PEOPLE'S REPUBLIC OF CHINA")).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - CHINA, PEOPLES REPUBLIC')).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - HONG KONG SAR, CHINA')).toBe('2026-10-05T12:00:00+08:00');
    expect(clock('EXAMPLE CITY - KOREA, REPUBLIC OF (SOUTH K.)')).toBe('2026-10-05T12:00:00+09:00');
    expect(clock('EXAMPLE CITY - CZECH REPUBLIC, THE')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('EXAMPLE CITY - IRELAND, REPUBLIC OF')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - TURKEY')).toBe('2026-10-05T12:00:00+03:00');
    expect(clock('EXAMPLE CITY - THAILAND')).toBe('2026-10-05T12:00:00+07:00');
    // Spain and Portugal file their islands under the country: the town tells.
    expect(clock('EXAMPLE CITY - SPAIN')).toBe('2026-10-05T12:00:00+02:00');
    expect(clock('TENERIFE - SPAIN')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('EXAMPLE CITY - PORTUGAL')).toBe('2026-10-05T12:00:00+01:00');
    expect(clock('PONTA DELGADA - PORTUGAL')).toBe('2026-10-05T12:00:00+00:00');
    // Several clocks and no region DHL names, an unknown country, or no country at all.
    for (const location of ['EXAMPLE CITY - USA', 'EXAMPLE CITY - Example - USA', 'EXAMPLE CITY - CANADA',
      'EXAMPLE CITY - UNITED STATES OF AMERICA', 'EXAMPLE CITY - EXAMPLELAND', 'FRANCE', '']) {
      expect(clock(location)).toBe('local 2026-10-05T12:00:00');
    }
  });
  it('rejects a foreign shipment and keeps reused waybills inconclusive', () => {
    expect(() => parse(payload(), '1234567880')).toThrow(SchemaError);
    const duplicate = payload(); duplicate.results[0]!.duplicate = true;
    expect(() => parse(duplicate, number)).toThrow(IndeterminateError);
    expect(() => parse({ results: [payload().results[0], payload().results[0]] }, number)).toThrow(IndeterminateError);
  });
  it('does not invent an instant from an invalid clock or turn empty history into movement', () => {
    const invalid = payload(); invalid.results[0]!.checkpoints[0]!.time = '25:06';
    expect(parse(invalid, number).events?.[0]).not.toHaveProperty('time');
    expect(parse(invalid, number).events?.[0]).not.toHaveProperty('local_time');
    expect(() => parse({ results: [{ id: number, checkpoints: [] }] }, number)).toThrow(IndeterminateError);
  });
});

describe('DHL Express retrieval', () => {
  it('recognizes over HTTP without invoking the browser', async () => {
    const fetcher = mobileFetcher();
    const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number, { budgetMs: 1000 })).toEqual({ known: true, lastActivityAt: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://dhle.dhl.com/access/access/com.dhl.exp.dhlmobile?appVersion=6.1.0&service=common-countrySettingsBySettingName');
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('service=shipments-tracking');
    const init = fetcher.mock.calls[1]![1]!;
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Bearer \S+$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ service: 'shipments', method: 'tracking',
      authentication: { provider: 'DEMP.RS1', login: '', token: '' },
      data: { airWayBill: number, countryCode: 'GB', languageCd: 'en', addShipmentToODD: 'N', moreDetails: 'Y', captchaVerificationData: {} } });
  });
  it('recovers a blocked HTTP request by capturing the exact waybill response', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(settings)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }));
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: `https://www.dhl.com/utapi?trackingNumber=${number}`, status: 200, headers: {},
        body: JSON.stringify(unifiedPayload()), truncated: false, base64Encoded: false, error: null }] });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    expect(await new DhlExpressTracker({ ...environment(fetcher, trawl), recorder }).fetch(number)).toMatchObject({ status: 'delivered' });
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({ step: 'trawl', fallbackFrom: 'direct', fallbackReason: 'challenge',
      fallbackErrorType: 'ChallengeError', fallbackError: expect.objectContaining({ status: 503 }) }));
    expect(scrape).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ skipHttp: true, captureResponses: ['https://www.dhl.com/utapi'] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await adapter(environment(fetcher, trawl)).recognizeWithBrowser!(number, { budgetMs: 20_000 })).toMatchObject({ known: true, result: { events: expect.any(Array) } });
    const request = scrape.mock.calls.at(-1)![0];
    expect(request.maxTimeout).toBeGreaterThan(17_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(18_000);
  });
  it('does not accept a foreign capture or retry a schema failure in a browser', async () => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: [] });
    const fetcher = mobileFetcher([{ id: '1234567880', checkpoints: [] }]);
    await expect(new DhlExpressTracker(environment(fetcher, trawl)).fetch(number)).rejects.toThrow(SchemaError);
    expect(scrape).not.toHaveBeenCalled();
    scrape.mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: 'https://www.dhl.com/utapi?trackingNumber=1234567880', status: 200,
        headers: {}, body: JSON.stringify(payload()), truncated: false, base64Encoded: false, error: null }] });
    await expect(new DhlExpressTracker(environment(fetcher, trawl)).browser(number)).rejects.toThrow('no complete matching');
    await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow(SchemaError);
    fetcher.mockResolvedValue(new Response('<html>blocked</html>'));
    await expect(new DhlExpressTracker(environment(fetcher)).fetch(number)).rejects.toThrow(ChallengeError);
  });
  it('starts nothing after cancellation or a spent budget', async () => {
    const fetcher = vi.fn<typeof fetch>(); const carrier = adapter(environment(fetcher));
    await expect(carrier.track({ number }, { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(carrier.track({ number }, { budgetMs: 0 })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('DHL mobile API', () => {
  it('derives status from sorted scans, uses English local dates and discards recipient and piece data', () => {
    const data = mobilePayload(); data[0]!.checkpoints.reverse();
    const result = parseMobile(data, number);
    expect(result).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2026-10-05T15:06:00',
      events: [{ stage: 'delivered', local_time: '2026-10-05T15:06:00' }, { stage: 'out_for_delivery' }, { stage: 'accepted' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|signature|signatory|pIds|counter|pieces/);
  });
  it('rejects foreign identities, duplicate shipments, invalid counters and empty histories', () => {
    expect(() => parseMobile(mobilePayload(), '1234567880')).toThrow(SchemaError);
    const data = mobilePayload(); data.push(data[0]!);
    expect(() => parseMobile(data, number)).toThrow(IndeterminateError);
    for (const counter of [0, 1.5, NaN, 2]) {
      const invalid = mobilePayload(); invalid[0]!.checkpoints[0]!.counter = counter;
      expect(() => parseMobile(invalid, number)).toThrow(SchemaError);
    }
    expect(() => parseMobile([{ id: number, checkpoints: [] }], number)).toThrow(IndeterminateError);
    expect(() => parseMobile([null], number)).toThrow(SchemaError);
  });
  it('accepts an empty list only after the configuration answered and never invokes the browser for not-found', async () => {
    const fetcher = mobileFetcher([]); const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number)).toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(carrier.track({ number })).rejects.toThrow(NotFoundError);
  });
  it('rejects missing, duplicate or malformed settings before sending a waybill', async () => {
    for (const configuration of [[], [null], [...settings, ...settings], [{ name: 'api_awb_encryption', value: {} }]]) {
      const fetcher = mobileFetcher([], configuration);
      await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(SchemaError);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('keeps changed encryption recoverable without sending a plaintext waybill', async () => {
    const fetcher = mobileFetcher([], [{ name: 'api_awb_encryption', value: 'Y' }]);
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(ChallengeError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    ['DRG10012', ChallengeError], [{ error: { error: 'DRG10013' } }, ChallengeError],
    [{ statusCode: 401 }, ChallengeError], ['temporary_blocked', RateLimitedError],
    [{ error: 'max_attempts_reached' }, RateLimitedError], [{ statusCode: 429 }, RateLimitedError],
    [{ statusCode: 404, error: 'Not Found' }, SchemaError],
  ])('preserves a mobile rejection without treating it as a missing shipment', async (reply, kind) => {
    await expect(new DhlExpressTracker(environment(mobileFetcher(reply))).direct(number)).rejects.toThrow(kind);
  });
  it('preserves HTTP throttles and distinguishes a missing API route from a missing shipment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    fetcher.mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toThrow(TransportError);
  });
  it('recognizes the mobile CAPTCHA code inside HTTP 503 and preserves its status for browser recovery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'DRG10012' }), { status: 503 }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'challenge', status: 503 });
    fetcher.mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number)).rejects.toMatchObject({ kind: 'maintenance', status: 503 });
  });
  const services = (fetcher: ReturnType<typeof mobileFetcher>) => fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('service'));
  it('reads the encryption setting once and reuses it until it expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fetcher = mobileFetcher(); const carrier = adapter(environment(fetcher));
      expect(await carrier.recognize!(number)).toMatchObject({ known: true });
      await expect(carrier.track({ number })).resolves.toMatchObject({ status: 'delivered' });
      vi.setSystemTime(Date.now() + SETTINGS_TTL_MS - 1);
      expect(await carrier.recognize!(number)).toMatchObject({ known: true });
      expect(services(fetcher)).toEqual(['common-countrySettingsBySettingName', 'shipments-tracking', 'shipments-tracking', 'shipments-tracking']);
      vi.setSystemTime(Date.now() + 1);
      fetcher.mockClear();
      expect(await carrier.recognize!(number)).toMatchObject({ known: true });
      expect(services(fetcher)).toEqual(['common-countrySettingsBySettingName', 'shipments-tracking']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('trusts an empty list under the reused setting and reads it again after a rejected or unexpected reply', async () => {
    const fetcher = mobileFetcher([]); const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number)).toEqual({ known: false });
    expect(await carrier.recognize!(number)).toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [reply, kind] of [['DRG10012', ChallengeError], [{ statusCode: 401 }, ChallengeError], ['temporary_blocked', RateLimitedError],
      [{ statusCode: 404, error: 'Not Found' }, SchemaError]] as const) {
      fetcher.mockClear().mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? reply : settings)));
      await expect(carrier.recognize!(number)).rejects.toThrow(kind);
      await expect(carrier.recognize!(number)).rejects.toThrow(kind);
      expect(services(fetcher)).toEqual(['shipments-tracking', 'common-countrySettingsBySettingName', 'shipments-tracking']);
      fetcher.mockImplementation(async (_url, init) => new Response(JSON.stringify(JSON.parse(String(init?.body)).method === 'tracking' ? [] : settings)));
      expect(await carrier.recognize!(number)).toEqual({ known: false });
    }
  });
  it('does not keep a refused setting or a failed settings read', async () => {
    const fetcher = mobileFetcher([], [{ name: 'api_awb_encryption', value: 'Y' }]); const tracker = new DhlExpressTracker(environment(fetcher));
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await expect(tracker.direct(number)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(tracker.direct(number)).rejects.toThrow(ChallengeError);
    expect(services(fetcher)).toEqual(Array(3).fill('common-countrySettingsBySettingName'));
  });
  it('keeps the setting when a tracking request gets no reply, the lookup is cancelled or its time runs out', async () => {
    const fetcher = mobileFetcher(); const tracker = new DhlExpressTracker(environment(fetcher));
    await tracker.direct(number);
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(tracker.direct(number)).rejects.toThrow(UpstreamNetworkError);
    const controller = new AbortController();
    fetcher.mockImplementationOnce(async () => { controller.abort(); throw controller.signal.reason; });
    await expect(tracker.direct(number, { signal: controller.signal })).rejects.toThrow();
    fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
    await expect(tracker.direct(number, { budgetMs: 20 })).rejects.toThrow();
    await expect(tracker.direct(number)).resolves.toMatchObject({ status: 'delivered' });
    expect(services(fetcher)).toEqual(['common-countrySettingsBySettingName', ...Array(5).fill('shipments-tracking')]);
  });
  it('does not send a second request when the caller cancels during configuration', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); return new Response(JSON.stringify(settings)); });
    await expect(new DhlExpressTracker(environment(fetcher)).direct(number, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});


describe('DHL public browser API', () => {
  it('preserves offsets, binds Express and excludes recipient and piece details', () => {
    const result = parseUnified(unifiedPayload(), number);
    expect(result).toMatchObject({ status: 'delivered', last_update: '2026-10-05T15:06:00-04:00', destination_country: 'CA',
      events: [{ time: '2026-10-05T15:06:00-04:00', provider_code: 'OK', stage: 'delivered', location: 'EXAMPLE CITY' },
        { stage: 'out_for_delivery' }, { stage: 'accepted', time: '2026-10-02T17:18:00-07:00' }] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|proofOfDelivery|consignee|pieceIds|streetAddress/);
  });
  it('rejects other identities, divisions, duplicate waybills and empty or malformed events', () => {
    expect(() => parseUnified(unifiedPayload(), '1234567880')).toThrow(SchemaError);
    for (const service of ['parcel-de', '']) {
      const data = unifiedPayload(); data.shipments[0]!.service = service;
      expect(() => parseUnified(data, number)).toThrow(IndeterminateError);
    }
    const data = unifiedPayload(); data.shipments.push(data.shipments[0]!);
    expect(() => parseUnified(data, number)).toThrow(IndeterminateError);
    const empty = unifiedPayload(); empty.shipments[0]!.events = [];
    expect(() => parseUnified(empty, number)).toThrow(IndeterminateError);
    expect(() => parseUnified({ shipments: [null] }, number)).toThrow(SchemaError);
  });
  it('does not invent UTC offsets or retain a delivery signatory', () => {
    const data = unifiedPayload(); data.shipments[0]!.events[0]!.description = 'Delivered to PRIVATE';
    for (const value of ['2026-10-05T15:06:00', '2026-10-05T15:06:00+99:00', '2026-02-30T15:06:00Z']) {
      data.shipments[0]!.events[0]!.timestamp = value;
      expect(parseUnified(data, number).events?.[0]).toMatchObject({ description: 'Delivered' });
      expect(parseUnified(data, number).events?.[0]?.time).toBeUndefined();
    }
  });
  function browser(responses: ReturnType<typeof captured>[]) {
    const trawl = new TrawlClient('https://browser.example');
    vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: responses });
    return environment(vi.fn<typeof fetch>(), trawl);
  }
  it('uses the final tracking reply after an intermediate challenge and recognizes its dated history', async () => {
    const env = browser([captured({}, 428), captured()]);
    expect(await adapter(env).recognizeWithBrowser!(number)).toMatchObject({ known: true, lastActivityAt: '2026-10-05T19:06:00.000Z', result: { events: expect.any(Array) } });
  });
  it('does not hide a later rejection behind an earlier success', async () => {
    await expect(new DhlExpressTracker(browser([captured(), captured({}, 428)])).browser(number)).rejects.toThrow(ChallengeError);
    await expect(new DhlExpressTracker(browser([{ ...captured(), body: '<html>blocked</html>' }])).browser(number)).rejects.toThrow(ChallengeError);
  });
  it('recognizes only the observed not-found envelope on the matching query', async () => {
    const missing = { status: 404, title: 'No result found', detail: 'No shipment with given tracking number found.' };
    expect(await adapter(browser([captured(missing, 404)])).recognizeWithBrowser!(number)).toEqual({ known: false, lastActivityAt: null });
    await expect(new DhlExpressTracker(browser([captured({}, 404)])).browser(number)).rejects.not.toThrow(NotFoundError);
    await expect(new DhlExpressTracker(browser([captured(missing, 404, `https://www.dhl.com/utapi?trackingNumber=${number}&trackingNumber=1234567880`)])).browser(number)).rejects.toThrow('no complete matching');
  });
});
