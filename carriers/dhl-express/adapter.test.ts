import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DhlExpressTracker, normalizeNumber, parse, parseUnified } from './adapter.js';

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
      last_update: '2026-10-05T15:06:00', events: [
        { time: '2026-10-05T15:06:00', stage: 'delivered' },
        { stage: 'out_for_delivery' }, { stage: 'accepted' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|signature|signatory/);
  });
  it('rejects a foreign shipment and keeps reused waybills inconclusive', () => {
    expect(() => parse(payload(), '1234567880')).toThrow(SchemaError);
    const duplicate = payload(); duplicate.results[0]!.duplicate = true;
    expect(() => parse(duplicate, number)).toThrow(IndeterminateError);
    expect(() => parse({ results: [payload().results[0], payload().results[0]] }, number)).toThrow(IndeterminateError);
  });
  it('does not invent an instant from an invalid clock or turn empty history into movement', () => {
    const invalid = payload(); invalid.results[0]!.checkpoints[0]!.time = '25:06';
    expect(parse(invalid, number).events?.[0]?.time).toBeUndefined();
    expect(() => parse({ results: [{ id: number, checkpoints: [] }] }, number)).toThrow(IndeterminateError);
  });
});

describe('DHL Express retrieval', () => {
  it('recognizes over HTTP without invoking the browser', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload())));
    const carrier = adapter(environment(fetcher));
    expect(await carrier.recognize!(number, { budgetMs: 1000 })).toEqual({ known: true, lastActivityAt: null });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`AWB=${number}`);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('recovers a blocked HTTP request by capturing the exact waybill response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>blocked</html>'));
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: `https://www.dhl.com/utapi?trackingNumber=${number}`, status: 200, headers: {},
        body: JSON.stringify(unifiedPayload()), truncated: false, base64Encoded: false, error: null }] });
    expect(await new DhlExpressTracker(environment(fetcher, trawl)).fetch(number)).toMatchObject({ status: 'delivered' });
    expect(scrape).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ skipHttp: true, captureResponses: ['https://www.dhl.com/utapi'] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await adapter(environment(fetcher, trawl)).recognizeWithBrowser!(number, { budgetMs: 20_000 })).toMatchObject({ known: true, result: { events: expect.any(Array) } });
    const request = scrape.mock.calls.at(-1)![0];
    expect(request.maxTimeout).toBeGreaterThan(17_000);
    expect(request.maxTimeout).toBeLessThanOrEqual(18_000);
  });
  it('does not accept a foreign capture or retry a schema failure in a browser', async () => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: [] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ results: [{ id: '1234567880', checkpoints: [] }] })));
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
