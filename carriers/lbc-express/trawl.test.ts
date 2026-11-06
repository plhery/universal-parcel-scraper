import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient, type TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { adapter, LBC_TRACK_PAGE, LBC_TRACK_REQUEST } from './adapter.js';
import { parseLbcWebsite } from './parser.js';

const NUMBER = '199999999977';
const url = `${LBC_TRACK_PAGE}?tracking-number=${NUMBER}`;
const website = () => JSON.parse(readFileSync(new URL('./fixtures/website.json', import.meta.url), 'utf8'));
const entry = (status = 200, body = JSON.stringify(website())): TrawlCapturedResponse => ({
  url: LBC_TRACK_REQUEST, status, body: status === 200 ? body : null, headers: {}, error: null,
  truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER,
});
function testSite(entries = [entry()], pageUrl = url, mobile?: string) {
  const fetcher = vi.fn<typeof fetch>(async (target, init) => {
    if (String(target) !== 'https://browser.test/scrape') return new Response(mobile ?? '', { status: mobile ? 200 : 401 });
    expect(init?.method).toBe('POST');
    const request = JSON.parse(String(init?.body));
    expect(request).toMatchObject({ url, skipHttp: true, maxTier: 3, captureResponses: [LBC_TRACK_REQUEST] });
    expect(request.maxTimeout).toBeLessThanOrEqual(25_000);
    return Response.json({ tier: 3, statusCode: 200, html: '', url: pageUrl, effectiveUrl: pageUrl, capturedResponses: entries });
  });
  const recorder = { ...NOOP_RECORDER, step: vi.fn() };
  const instance = adapter({ fetcher, recorder, trawl: new TrawlClient('https://browser.test'), env: {}, browserExecutablePath: null });
  return { instance, fetcher, recorder };
}

describe('LBC configured service recovery', () => {
  it('recovers a refused guest API through bound decoded history and records the original challenge', async () => {
    const site = testSite([entry(403), entry()]);
    expect(await site.instance.track({ number: NUMBER })).toEqual(parseLbcWebsite(website(), NUMBER));
    expect(site.fetcher).toHaveBeenCalledTimes(2);
    expect(site.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lbc-express', step: 'trawl', outcome: 'ok', fallbackReason: 'challenge' }));
    expect(site.instance.steps).toEqual(['direct', 'trawl', 'browser']);
  });

  it('keeps a later refusal, rate limit or network failure over an earlier success', async () => {
    for (const [status, kind] of [[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance'], [0, 'transport']] as const) {
      const last = { ...entry(status), headers: { 'retry-after': '45' } };
      const site = testSite([entry(), last]);
      await expect(site.instance.track({ number: NUMBER })).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 45_000 } : {}) });
      expect(site.fetcher).toHaveBeenCalledTimes(2);
    }
  });

  it('refuses unbound, mismatched, unreadable and truncated captures', async () => {
    await expect(testSite([{ ...entry(), trackingNumberSubmitted: undefined }]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    for (const row of [{ ...entry(), trackingNumberSubmitted: NUMBER + '9' },
      { ...entry(), error: 'compressed body omitted' }, { ...entry(), truncated: true }, { ...entry(), base64Encoded: true },
      entry(200, 'changed JSON'), entry(200, JSON.stringify(website()).replace(NUMBER, NUMBER + '9'))]) {
      await expect(testSite([row]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    }
    const wrong = entry(200, JSON.stringify(website()).replace(NUMBER, NUMBER + '9'));
    await expect(testSite([wrong, entry()]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    await expect(testSite([entry()], 'https://www.lbcexpress.com/account/').instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps missing responses and an empty parcel history inconclusive', async () => {
    await expect(testSite([]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    const body = website();
    body.data.Body.LBCTrackAndTraceResponse.LBCTrackAndTraceResult.TrackingStatus.TrackingHistory = [];
    await expect(testSite([entry(200, JSON.stringify(body))]).instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('does not spend a browser lookup on a complete mobile result or a malformed mobile reply', async () => {
    const mobile = readFileSync(new URL('./fixtures/mobile.xml', import.meta.url), 'utf8');
    const site = testSite([entry()], url, mobile);
    expect((await site.instance.track({ number: NUMBER })).events).toHaveLength(3);
    expect(site.fetcher).toHaveBeenCalledTimes(1);
    const malformed = testSite([entry()], url, 'changed XML');
    await expect(malformed.instance.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
    expect(malformed.fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation and reserves the service response allowance', async () => {
    const site = testSite();
    await expect(site.instance.track({ number: NUMBER }, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(site.fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    const aborted = testSite();
    await expect(aborted.instance.track({ number: NUMBER }, { signal: controller.signal })).rejects.toThrow();
    expect(aborted.fetcher).not.toHaveBeenCalled();
  });
});
