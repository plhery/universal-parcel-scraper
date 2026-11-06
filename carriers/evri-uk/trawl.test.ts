import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TransportError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import * as localBrowser from '../../core/transport/localBrowser.js';
import { TrawlClient, type TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { adapter, EvriUkTracker } from './adapter.js';
import * as mobile from './mobile.js';
import { evriUkTrackingUrl, parseEvriUk } from './parser.js';

const NUMBER = 'H000000000000001', URN = 'urn:parcel_id:barcode:date:123456:' + NUMBER + ':2026-01-03';
const url = evriUkTrackingUrl(NUMBER), searchUrl = 'https://api.evri.com/customer-tracking/v1/search/' + NUMBER;
const historyBase = 'https://tracking.platform-apis.evri.com/v1/parcels';
const historyUrl = historyBase + '?' + new URLSearchParams({ uniqueIds: URN }).toString();
const history = () => JSON.parse(readFileSync(new URL('./fixtures/history.json', import.meta.url), 'utf8'));
const search = () => ({ parcels: [{ brand: { name: 'EVRI' }, identifiers: [
  { type: 'PARCEL_ID', value: '123456' }, { type: 'BARCODE', value: NUMBER },
] }] });
const entry = (target = searchUrl, payload: unknown = search(), status = 200): TrawlCapturedResponse => ({
  url: target, status, body: status === 200 ? JSON.stringify(payload) : null, headers: {}, error: null,
  truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER,
});
const entries = () => [entry(), entry(historyUrl, history())];

function site(captures = entries(), pageUrl = url, mobile?: (target: string) => Response) {
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    if (String(target) !== 'https://browser.test/scrape') return mobile?.(String(target)) ?? new Response('', { status: 403 });
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({ url, skipHttp: true, maxTier: 3, captureResponses: [searchUrl, historyBase] });
    expect(request.maxTimeout).toBeLessThanOrEqual(25_000);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ tier: 3, statusCode: 200, html: '', url: pageUrl, effectiveUrl: pageUrl, capturedResponses: captures });
  });
  const recorder = { ...NOOP_RECORDER, step: vi.fn() };
  const instance = adapter({ fetcher, recorder, trawl: new TrawlClient('https://browser.test'), env: {}, browserExecutablePath: null });
  return { instance, fetcher, recorder };
}

describe('Evri UK configured TRAWL recovery', () => {
  it('recovers the refused mobile API with bound search/history and records provenance', async () => {
    const test = site([entry(searchUrl, undefined, 403), ...entries()]);
    expect(await test.instance.track({ number: NUMBER })).toEqual(parseEvriUk(history(), NUMBER, URN));
    expect(test.fetcher).toHaveBeenCalledTimes(2);
    expect(test.instance.steps).toEqual(['direct', 'trawl', 'browser']);
    expect(test.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'evri-uk', step: 'trawl', outcome: 'ok', fallbackReason: 'challenge' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [404, 'transport'], [0, 'transport']] as const)(
    'keeps a final HTTP%s over earlier successful history', async (status, kind) => {
      const last = { ...entry(historyUrl, undefined, status), headers: { 'retry-after': '45' } };
      await expect(site([...entries(), last]).instance.track({ number: NUMBER }))
        .rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 45_000 } : {}) });
    });

  it('rejects wrong whole barcodes, search aliases, URNs and redirected history', async () => {
    const wrongSearch = search(); wrongSearch.parcels[0]!.identifiers[1]!.value = NUMBER + '9';
    const wrongHistory = history(); wrongHistory.results[0].uniqueId = URN + '9';
    for (const captures of [
      [entry(searchUrl, wrongSearch), entry(historyUrl, history())],
      [entry(), entry(historyUrl, wrongHistory)],
      [entry(), entry(historyUrl.replace('123456', '987654'), history())],
      [entry(), entry(historyUrl + '&uniqueIds=' + encodeURIComponent(URN), history())],
      [...entries(), entry(searchUrl + '9')],
      [entry(), { ...entry(historyUrl, history()), trackingNumberSubmitted: NUMBER + '9' }],
    ]) await expect(site(captures).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(site(entries(), 'https://www.evri.com/account').instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(site([{ ...entry(), trackingNumberSubmitted: undefined }]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('requires search ownership before accepting history and preserves ambiguous/empty scope', async () => {
    await expect(site([entry(historyUrl, history())]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    for (const payload of [{ parcels: [] }, { parcels: [search().parcels[0], search().parcels[0]] },
      { parcels: [{ ...search().parcels[0], brand: { name: 'EVRI_INTERNATIONAL' } }] },
      { parcels: [{ ...search().parcels[0], externalRedirectUrl: 'redirected' }] }]) {
      await expect(site([entry(searchUrl, payload)]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const empty = history(); empty.results[0].trackingEvents = [];
    await expect(site([entry(), entry(historyUrl, empty)]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps WAF, malformed bodies, truncation and unfinished requests distinct', async () => {
    await expect(site([{ ...entry(), error: 'verification-required', body: null }]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(site([...entries(), { ...entry(historyUrl, undefined, 0), error: 'tracking-request-unfinished' }]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    for (const row of [{ ...entry(), truncated: true }, { ...entry(), error: 'invalid-json' },
      { ...entry(), body: 'changed JSON' }, { ...entry(), base64Encoded: true }, entry(searchUrl, { invalid: true })]) {
      await expect(site([row, ...entries()]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(site([]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('keeps HTTP recognition and complete or unconfirmed mobile answers out of TRAWL', async () => {
    const reference = () => Response.json({ parcelIdentifiers: [{ urn: URN }] });
    const complete = site(entries(), url, target => target.includes('/reference/') ? reference() : Response.json(history()));
    expect(await complete.instance.track({ number: NUMBER })).toEqual(parseEvriUk(history(), NUMBER, URN));
    expect(complete.fetcher).toHaveBeenCalledTimes(2);
    expect(complete.fetcher.mock.calls.some(([target]) => String(target).includes('browser.test'))).toBe(false);
    const recognized = site(entries(), url, reference);
    await expect(recognized.instance.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    expect(recognized.fetcher).toHaveBeenCalledTimes(1);
    const empty = site(entries(), url, () => Response.json({ parcelIdentifiers: [] }));
    await expect(empty.instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
    expect(empty.fetcher).toHaveBeenCalledTimes(1);
  });

  it('reserves transport time and stops cancelled lookups without another request', async () => {
    const test = site();
    await expect(test.instance.track({ number: NUMBER }, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(test.fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    const aborted = site();
    await expect(aborted.instance.track({ number: NUMBER }, { signal: controller.signal })).rejects.toThrow();
    expect(aborted.fetcher).not.toHaveBeenCalled();
  });

  it('preserves local browser recovery when the service response reserve cannot fit', async () => {
    const test = site();
    const browser = vi.spyOn(localBrowser, 'withLocalBrowser').mockRejectedValue(new TransportError('Evri UK', 'Local recovery reached'));
    try {
      const tracker = new EvriUkTracker({ fetcher: test.fetcher, executablePath: '/synthetic/chromium',
        trawl: new TrawlClient('https://browser.test') });
      await expect(tracker.fetch(NUMBER, { budgetMs: 14_000 })).rejects.toMatchObject({ message: 'Local recovery reached' });
      expect(browser).toHaveBeenCalledTimes(1);
      expect(test.fetcher).toHaveBeenCalledTimes(1);
    } finally { browser.mockRestore(); }
  });

  it('keeps the full direct allowance when a service timeout would leave no service window', async () => {
    const direct = vi.spyOn(mobile, 'readEvriUkMobile').mockResolvedValue(parseEvriUk(history(), NUMBER, URN));
    try {
      const tracker = new EvriUkTracker({ trawl: new TrawlClient('https://browser.test') });
      await tracker.fetch(NUMBER, { budgetMs: 20_000 });
      expect(direct.mock.calls[0]![1].timeoutMs).toBeGreaterThan(15_000);
      expect(direct.mock.calls[0]![1].timeoutMs).toBeLessThanOrEqual(20_000);
    } finally { direct.mockRestore(); }
  });

  it('validates and flags all distinct history before applying the event cap', () => {
    const raw = history();
    const source = raw.results[0].trackingEvents[0];
    raw.results[0].trackingEvents = Array.from({ length: 101 }, (_, i) => ({
      ...source, dateTime: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }));
    expect(parseEvriUk(raw, NUMBER, URN)).toMatchObject({ history_truncated: true, events: expect.any(Array) });
    expect(parseEvriUk(raw, NUMBER, URN).events).toHaveLength(100);
    raw.results[0].trackingEvents[100] = { dateTime: source.dateTime };
    expect(() => parseEvriUk(raw, NUMBER, URN)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
