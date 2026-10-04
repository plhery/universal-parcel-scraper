import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { TrawlClient } from '../../core/transport/index.js';
import { adapter, DhlExpressTracker, normalizeNumber, parse } from './adapter.js';

const number = '1234567891';
const payload = () => ({ results: [{ id: number, duplicate: false, hasDuplicateShipment: false,
  consigneeCountryCode: 'CA', signature: { signatory: 'PRIVATE', link: { url: 'https://example.invalid/private' } },
  checkpoints: [
    { description: 'Delivered', date: 'Monday, October 05, 2026', time: '15:06', location: 'EXAMPLE CITY - CANADA' },
    { description: 'Shipment is out with courier for delivery', date: 'Monday, October 05, 2026', time: '12:35' },
    { description: 'Shipment picked up', date: 'Friday, October 02, 2026', time: '17:18', location: 'EXAMPLE CITY - USA' },
  ] }] });
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
      capturedResponses: [{ url: `https://mydhl.express.dhl/shipmentTracking?AWB=${number}`, status: 200, headers: {},
        body: JSON.stringify(payload()), truncated: false, base64Encoded: false, error: null }] });
    expect(await new DhlExpressTracker(environment(fetcher, trawl)).fetch(number)).toMatchObject({ status: 'delivered' });
    expect(scrape).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ skipHttp: true, captureResponses: ['https://mydhl.express.dhl/shipmentTracking'] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await adapter(environment(fetcher, trawl)).recognizeWithBrowser!(number, { budgetMs: 20_000 })).toMatchObject({ known: true, result: { events: expect.any(Array) } });
  });
  it('does not accept a foreign capture or retry a schema failure in a browser', async () => {
    const trawl = new TrawlClient('https://browser.example');
    const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {}, capturedResponses: [] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ results: [{ id: '1234567880', checkpoints: [] }] })));
    await expect(new DhlExpressTracker(environment(fetcher, trawl)).fetch(number)).rejects.toThrow(SchemaError);
    expect(scrape).not.toHaveBeenCalled();
    scrape.mockResolvedValue({ url: '', html: '', cookies: [], userAgent: null, tier: 2, statusCode: 200, raw: {},
      capturedResponses: [{ url: 'https://mydhl.express.dhl/shipmentTracking?AWB=1234567880', status: 200,
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
