import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { UpstreamHttpError } from '../../core/transport/index.js';
import { IndeterminateError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import * as trackingBrowser from '../../core/transport/browser.js';
import { stageFor } from './status.js';
import {
  DHLEcommerceSessionError, DHLEcommerceTracker, dhlEcommerceTrackingUrl,
  normalizeDHLEcommerceNumber, parseDHLEcommerceResponse, parseDHLEcommerceWebtrackResponse,
} from './adapter.js';

const NUMBER = '33870000000000001';
const EMPTY_WEBTRACK = { total: 0, limit: 10, offset: 0, packages: [] };

it('uses browser recognition only for recoverable HTTP failures and retains the history', async () => {
  const result: CarrierResult = { status: 'in_transit', events: [{ time: '2026-09-09T08:00:00Z', description: 'Sorted' }] };
  const page = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockResolvedValue(result);
  const tracker = new DHLEcommerceTracker();
  for (const error of [new RateLimitedError('DHL eCommerce'), new SchemaError('DHL eCommerce')]) {
    await expect(tracker.recognizeWithBrowser(NUMBER, {}, error)).rejects.toBe(error);
  }
  expect(page).not.toHaveBeenCalled();
  await expect(tracker.recognizeWithBrowser(NUMBER, { budgetMs: 1_000 },
    new IndeterminateError('DHL eCommerce', 'Regional miss', { reason: 'webtrack_not_found' })))
    .resolves.toMatchObject({ known: true, lastActivityAt: '2026-09-09T08:00:00.000Z', result });
  expect(page).toHaveBeenCalledOnce();
  page.mockRestore();
});
function webtrack() {
  return {
    total: 1, limit: 10, offset: 0,
    packages: [{
      trackedValue: NUMBER, tmiUid: 'synthetic-package-id', trackingId: 'GM1234567890123456',
      packageId: 'SYNTHETICPACKAGE123', status: 'En Route', estimatedDeliveryDate: '2026-09-14',
      sender: { name: 'Synthetic Webshop', postalCode: 'PRIVATE POSTCODE' },
      recipient: { name: 'PRIVATE RECIPIENT', address: 'PRIVATE ADDRESS' },
      events: [
        { primaryEventDescription: 'EN ROUTE', date: '2026-09-09', time: '05:40:17', timeZone: 'LT', location: 'FR' },
        { primaryEventDescription: 'PACKAGE RECEIVED AT DHL ECOMMERCE DISTRIBUTION CENTER', date: '2026-09-02', time: '05:04:26', timeZone: 'CT', location: 'Melrose Park, IL, US' },
        { primaryEventDescription: 'LABEL CREATED', date: '2026-08-31', time: '03:11:58', timeZone: 'ET', location: 'Hebron, KY, US' },
      ],
    }],
  };
}
function reply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

interface Scan { description: string; statusCode: string; timestamp: string; location: { address: Record<string, unknown> } }
interface Payload {
  shipments: ({ id: string; service: string; status: Scan; events: Scan[]; estimatedTimeOfDelivery?: string; returnFlag?: boolean } & Record<string, unknown>)[];
}

function json<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')) as T;
}

function event(description = 'EN ROUTE', statusCode = 'transit', timestamp = '2026-09-09T05:40:17', address = { addressLocality: 'FR' }): Scan {
  return { description, statusCode, timestamp, location: { address } };
}
function shipment(): Payload {
  return json<Payload>('./fixtures/in-transit.json');
}

afterEach(() => vi.restoreAllMocks());

describe('DHL eCommerce normalization', () => {
  it('requires text before using a translated delivery label', () => {
    expect(stageFor({ description: ['Delivered'], statusCode: 'transit' })).toBe('in_transit');
    expect(stageFor({ description: { text: 'Delivered' }, statusCode: 'transit' })).toBe('in_transit');
    expect(stageFor({ description: ['unknown'], statusCode: 'delivered' })).toBe('delivered');
  });

  it('reads aliases, converts local timestamps, keeps announcement stages and discards private fields', () => {
    const result = parseDHLEcommerceResponse(shipment());
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-09-09T03:40:17.000Z', expected_delivery: '2026-09-14' });
    expect(result.events?.[1]).toMatchObject({ time: '2026-08-31T07:11:58.000Z', stage: 'registered' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('customer-confirmation');
  });

  it('produces every capability declared in carrier.json, without private fields', () => {
    const checks: Record<string, (result: CarrierResult) => unknown> = {
      history: (result) => result.events?.length,
      location: (result) => result.events?.some((scan) => scan.location),
      eta: (result) => result.expected_delivery,
      sender_name: (result) => result.sender_name,
      delivered_at: (result) => result.delivered_at,
    };
    const declared = json<{ capabilities: string[] }>('./carrier.json').capabilities;
    const results = [parseDHLEcommerceResponse(shipment()), parseDHLEcommerceResponse(json<Payload>('./fixtures/delivered.json'))];
    expect(declared.length).toBeGreaterThan(0);
    for (const capability of declared) {
      expect(checks[capability], `no check for capability ${capability}`).toBeDefined();
      expect(results.some((result) => Boolean(checks[capability]!(result))), capability).toBe(true);
    }
    for (const result of results) expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    ['MANIFEST DATA RECEIVED', 'unknown', 'registered', 'pending'],
    ['EN ROUTE TO DHL ECOMMERCE OR AWAITING PROCESSING', 'transit', 'registered', 'pending'],
    ['PACKAGE RECEIVED AT DHL ECOMMERCE DISTRIBUTION CENTER', 'transit', 'accepted', 'in_transit'],
    ['OUT FOR DELIVERY', 'transit', 'out_for_delivery', 'out_for_delivery'],
    ['READY FOR COLLECTION', 'transit', 'ready_for_pickup', 'out_for_delivery'],
    ['CUSTOMS CLEARANCE', 'transit', 'customs', 'in_transit'],
    ['CUSTOMS CLEARED', 'transit', 'in_transit', 'in_transit'],
    ['Carrier exception', 'failure', 'exception', 'exception'],
    ['DELIVERY ATTEMPT FAILED', 'failure', 'failed_attempt', 'exception'],
    ['RETURNED TO SENDER', 'delivered', 'returned', 'exception'],
    ['Signed by PRIVATE', 'delivered', 'delivered', 'delivered'],
  ])('maps %s without inventing progress', (description, code, stage, status) => {
    const payload = shipment(); payload.shipments[0]!.status = event(description, code);
    payload.shipments[0]!.events = [payload.shipments[0]!.status];
    const result = parseDHLEcommerceResponse(payload);
    expect(result).toMatchObject({ current_stage: stage, status });
    if (stage === 'delivered' || stage === 'returned') expect(result.expected_delivery).toBeNull();
    if (stage === 'delivered') expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('handles return delivery flags and invalid delivery estimates', () => {
    const payload = shipment(); payload.shipments[0]!.status = event('Delivered', 'delivered');
    payload.shipments[0]!.returnFlag = true;
    expect(parseDHLEcommerceResponse(payload)).toMatchObject({ current_stage: 'returned', expected_delivery: null });
    payload.shipments[0]!.status = event(); payload.shipments[0]!.estimatedTimeOfDelivery = '2026-02-31';
    expect(parseDHLEcommerceResponse(payload).expected_delivery).toBeNull();
  });

  it('does not fabricate UTC timestamps for unknown localities, and honors explicit offsets', () => {
    const payload = shipment(); payload.shipments[0]!.events = [
      event('EN ROUTE', 'transit', '2026-09-01T09:00:00', { addressLocality: 'Unknown' }),
      event('PROCESSED', 'transit', '2026-09-01T09:00:00-05:00', { addressLocality: 'Unknown' }),
      event('EN ROUTE', 'transit', 'invalid'),
    ];
    expect(parseDHLEcommerceResponse(payload).events).toEqual([
      expect.objectContaining({ time: '2026-09-01T14:00:00.000Z' }),
    ]);
  });

  it('rejects ambiguous, malformed and other-division responses', () => {
    for (const payload of [{}, { shipments: [] }, { shipments: [shipment().shipments[0], shipment().shipments[0]] },
      { shipments: [{ ...shipment().shipments[0], service: 'express' }] },
      { shipments: [{ ...shipment().shipments[0], status: {} }] },
      { shipments: [{ ...shipment().shipments[0], events: {} }] }]) {
      expect(() => parseDHLEcommerceResponse(payload)).toThrow();
    }
  });

  it('normalizes numbers and creates the global tracking link', () => {
    expect(normalizeDHLEcommerceNumber('gm 1234-5678.9012 3456')).toBe('GM1234567890123456');
    expect(dhlEcommerceTrackingUrl(NUMBER)).toContain(`tracking-id=${NUMBER}&submit=1`);
    expect(() => normalizeDHLEcommerceNumber('https://evil.example')).toThrow();
  });
});

describe('DHL eCommerce fetching', () => {
  beforeEach(() => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(EMPTY_WEBTRACK)));
  it('rejects invalid timeouts before doing any work', () => {
    for (const timeoutMs of [0, -1, Infinity, NaN, 60_001]) {
      expect(() => new DHLEcommerceTracker({ timeoutMs })).toThrow('timeout');
    }
  });

  it('uses the global browser when the regional HTTP endpoint does not list the shipment', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, spec, parse) => {
      expect(spec.url).toBe(dhlEcommerceTrackingUrl(NUMBER));
      expect(spec.responseUrl).toBe(`https://www.dhl.com/utapi?trackingNumber=${NUMBER}&language=en&requesterCountryCode=CH&source=tt`);
      return parse(shipment());
    });
    const result = await new DHLEcommerceTracker({ executablePath: '/test/chromium', timeoutMs: 30000 }).fetch(NUMBER);
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).toHaveBeenCalledOnce();
    expect(browser.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(30000);
  });

  it('propagates browser failures after a regional miss', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new Error('Browser unavailable'));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects.toThrow('Browser unavailable');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).toHaveBeenCalledOnce();
  });

  it('names the challenge statuses so the host keeps the upstream status', async () => {
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new UpstreamHttpError('DHL eCommerce', 428));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toMatchObject({ name: 'DHLEcommerceSessionError', status: 428 });
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toBeInstanceOf(DHLEcommerceSessionError);
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockRejectedValue(new UpstreamHttpError('DHL eCommerce', 503));
    await expect(new DHLEcommerceTracker({ executablePath: '/test/chromium' }).fetch(NUMBER)).rejects
      .toMatchObject({ name: 'UpstreamHttpError', status: 503 });
  });

  it('answers a lookup cancelled in the queue at once, without a browser and without failing the one behind it', async () => {
    let finish!: (result: CarrierResult) => void;
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage')
      .mockImplementationOnce(() => new Promise<CarrierResult>((resolve) => { finish = resolve; }))
      .mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium' });
    const controller = new AbortController();
    const first = tracker.fetch(NUMBER);
    const cancelled = tracker.fetch(NUMBER, { signal: controller.signal });
    const behind = tracker.fetch(NUMBER);
    await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toThrow('caller cancelled');
    finish(parseDHLEcommerceResponse(shipment()));
    await expect(first).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(behind).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('counts the wait in the queue against a budget the caller set', async () => {
    let finish!: (result: CarrierResult) => void;
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage')
      .mockImplementationOnce(() => new Promise<CarrierResult>((resolve) => { finish = resolve; }))
      .mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium' });
    const first = tracker.fetch(NUMBER);
    await expect(tracker.fetch(NUMBER, { budgetMs: 40 })).rejects.toMatchObject({ name: 'BudgetExceededError', kind: 'budget' });
    finish(parseDHLEcommerceResponse(shipment()));
    await expect(first).resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('reports the browser step through the recorder', async () => {
    vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const steps: string[] = [];
    const lookups: (string | null)[] = [];
    await new DHLEcommerceTracker({ executablePath: '/test/chromium', recorder: {
      step: ({ step }) => { steps.push(step); },
      lookup: ({ finalStep }) => { lookups.push(finalStep); },
    } }).fetch(NUMBER);
    expect(steps).toEqual(['direct', 'browser']);
    expect(lookups).toEqual(['browser']);
  });
});

describe('DHL eCommerce Webtrack', () => {
  it('binds an alias to one identified package and reads only public tracking fields', () => {
    const result = parseDHLEcommerceWebtrackResponse(webtrack(), NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_update: '2026-09-09T03:40:17.000Z', expected_delivery: '2026-09-14', sender_name: 'Synthetic Webshop' });
    expect(result.events).toEqual([
      expect.objectContaining({ time: '2026-09-09T03:40:17.000Z', stage: 'in_transit' }),
      expect.objectContaining({ time: '2026-09-02T10:04:26.000Z', stage: 'accepted' }),
      expect.objectContaining({ time: '2026-08-31T07:11:58.000Z', stage: 'registered' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(JSON.stringify(result)).not.toContain('synthetic-package-id');
    expect(JSON.stringify(result)).not.toContain('GM1234567890123456');
  });

  it('accepts an exact returned carrier identifier and rejects a query echo without a package identity', () => {
    const payload = webtrack();
    expect(parseDHLEcommerceWebtrackResponse(payload, 'GM1234567890123456').events).toHaveLength(3);
    payload.packages[0]!.trackingId = ''; payload.packages[0]!.packageId = '';
    expect(() => parseDHLEcommerceWebtrackResponse(payload, NUMBER)).toThrow('unidentified');
  });

  it('keeps unresolved local clocks separate and validates explicit offsets and impossible dates', () => {
    const payload = webtrack(); payload.packages[0]!.events = [
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00', timeZone: 'LT', location: 'Unknown' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00-05:00', timeZone: 'LT', location: 'Unknown' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-02-31', time: '09:00:00', timeZone: 'LT', location: 'FR' },
      { primaryEventDescription: 'EN ROUTE', date: '2026-09-01', time: '09:00:00+99:00', timeZone: 'LT', location: 'FR' },
    ];
    expect(parseDHLEcommerceWebtrackResponse(payload, NUMBER).events).toEqual([
      expect.objectContaining({ local_time: '2026-09-01T09:00:00' }),
      expect.objectContaining({ time: '2026-09-01T14:00:00.000Z' }),
    ]);
  });

  it('cleans delivery signatures and excludes delivered estimates', () => {
    const payload = webtrack(); payload.packages[0]!.status = 'Delivered';
    payload.packages[0]!.events[0]!.primaryEventDescription = 'Delivered to PRIVATE SIGNATORY';
    const result = parseDHLEcommerceWebtrackResponse(payload, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-09-09T03:40:17.000Z', expected_delivery: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects mismatched, ambiguous and malformed histories instead of triggering a browser', async () => {
    const base = webtrack(); const parcel = base.packages[0]!;
    const cases = [ {}, { ...base, packages: [{ ...parcel, trackedValue: '33870000000000002' }] },
      { ...base, total: 2, packages: [parcel, parcel] }, { ...base, total: 2 }, { ...base, offset: 1 },
      { ...base, total: 0 }, { ...base, packages: [{ ...parcel, events: [{}] }, parcel] },
      { ...base, errors: [{ message: 'Unavailable' }] }, { ...base, packages: [{ ...parcel, tmiUid: '' }] },
      { ...base, packages: [{ ...parcel, events: [null] }] }, { ...base, packages: [{ ...parcel, status: '' }] },
    ];
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    for (const payload of cases) {
      const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply(payload)) });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
    expect(browser).not.toHaveBeenCalled();
  });

  it('posts one anonymous lookup and finishes without Chromium when native history is available', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.dhlecs.com/webtrack/v4/tracking');
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ trackedValue: NUMBER, offset: 0, locale: 'en-US' }) });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return reply(webtrack());
    });
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const steps: string[] = [];
    const result = await new DHLEcommerceTracker({ fetcher, recorder: { step: ({ step }) => steps.push(step), lookup: () => {} } }).fetch(NUMBER);
    expect(result.events).toHaveLength(3); expect(fetcher).toHaveBeenCalledOnce();
    expect(browser).not.toHaveBeenCalled(); expect(steps).toEqual(['direct']);
  });

  it('recognizes native history and clean regional misses without invoking a browser', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const fetcher = vi.fn(async () => reply(webtrack()));
    const tracker = new DHLEcommerceTracker({ fetcher });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-09-09T03:40:17.000Z' });
    fetcher.mockImplementation(async () => reply(EMPTY_WEBTRACK));
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: false });
    await expect(tracker.recognize('invalid!')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(browser).not.toHaveBeenCalled();
  });

  it('preserves outage, challenge and malformed answers during recognition', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    for (const status of [403, 404, 410, 429, 503]) {
      const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({}, status)) });
      await expect(tracker.recognize(NUMBER)).rejects.toBeInstanceOf(Error);
    }
    const tracker = new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({ packages: [] })) });
    await expect(tracker.recognize(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(browser).not.toHaveBeenCalled();
  });

  it('retains the global route for an identified package with no regional history', async () => {
    const payload = webtrack(); payload.packages[0]!.events = [];
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    await expect(new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply(payload)) }).fetch(NUMBER)).resolves.toMatchObject({ status: 'in_transit' });
    expect(browser).toHaveBeenCalledOnce();
  });

  it('uses the independent global route when the regional API is unavailable', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, _spec, parse) => parse(shipment()));
    const cases = [
      vi.fn(async () => reply({}, 503)),
      vi.fn(async () => { throw new Error('Network unavailable'); }),
    ];
    for (const fetcher of cases) {
      await expect(new DHLEcommerceTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ status: 'in_transit', events: expect.any(Array) });
      expect(fetcher).toHaveBeenCalledOnce();
    }
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('does not spend a browser attempt on a regional rate limit', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    await expect(new DHLEcommerceTracker({ fetcher: vi.fn(async () => reply({}, 429)) }).fetch(NUMBER)).rejects.toMatchObject({ status: 429 });
    expect(browser).not.toHaveBeenCalled();
  });

  it('passes the recognition budget and cancellation to its only HTTP request', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    });
    const controller = new AbortController();
    const recognition = new DHLEcommerceTracker({ fetcher }).recognize(NUMBER, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(recognition).rejects.toMatchObject({ kind: 'transport' });
    await expect(new DHLEcommerceTracker({ fetcher }).recognize(NUMBER, { budgetMs: 5 })).rejects.toMatchObject({ kind: 'transport' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('DHL eCommerce USPS routing barcodes', () => {
  // A synthetic 9261 PIC with its check digit, behind a made-up ZIP code.
  const PIC = '9261290000000012345677';
  const BARCODE = `42000000${PIC}`;
  function routed() {
    const payload = webtrack();
    Object.assign(payload.packages[0]!, { trackedValue: PIC, trackingId: BARCODE, deliveryConfirmationNumber: PIC });
    return payload;
  }

  it('asks Webtrack for the package identifier and reports it, never the ZIP code', async () => {
    for (const raw of [BARCODE, `420 00000 ${PIC}`, `420000000000${PIC}`]) expect(normalizeDHLEcommerceNumber(raw)).toBe(PIC);
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBe(JSON.stringify({ trackedValue: PIC, offset: 0, locale: 'en-US' }));
      return reply(routed());
    });
    const tracker = new DHLEcommerceTracker({ fetcher });
    const result = await tracker.fetch(BARCODE);
    expect(result).toMatchObject({ status: 'in_transit', canonical_tracking_number: PIC });
    expect(JSON.stringify(result)).not.toContain(BARCODE);
    expect(await tracker.fetch(PIC)).not.toHaveProperty('canonical_tracking_number');
    await expect(tracker.recognize(BARCODE)).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('opens the global page with the package identifier after a regional miss', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage').mockImplementation(async (_options, spec, parse) => {
      expect(spec.url).toBe(dhlEcommerceTrackingUrl(PIC));
      expect(spec.responseUrl).toContain(`trackingNumber=${PIC}&`);
      return parse(shipment());
    });
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium', fetcher: vi.fn(async () => reply(EMPTY_WEBTRACK)) });
    await expect(tracker.fetch(BARCODE)).resolves.toMatchObject({ canonical_tracking_number: PIC });
    // The result recognition lends the lookup names it too.
    await expect(tracker.recognizeWithBrowser(BARCODE)).resolves.toMatchObject({ known: true, result: { canonical_tracking_number: PIC } });
    expect(browser).toHaveBeenCalledTimes(2);
  });

  it('sends no routing barcode without a single package identifier', async () => {
    const browser = vi.spyOn(trackingBrowser, 'scrapeUniversalPage');
    const fetcher = vi.fn(async () => reply(routed()));
    const tracker = new DHLEcommerceTracker({ executablePath: '/test/chromium', fetcher });
    // A wrong check digit, and a ZIP+4 whose 26-digit reading fits as well as the PIC after it.
    for (const raw of [`42000000${PIC.slice(0, -1)}8`, `420000009300${PIC}`]) {
      expect(() => normalizeDHLEcommerceNumber(raw)).toThrow('single package identifier');
      await expect(tracker.fetch(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(tracker.recognize(raw)).resolves.toEqual({ known: false });
      await expect(tracker.recognizeWithBrowser(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });
});
