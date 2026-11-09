import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, WesternBidTracker } from './adapter.js';
import { WESTERN_BID_READY, westernBidApiUrl, westernBidTrackingUrl } from './parser.js';

const NUMBER = 'WBX731594268109', ALIAS = '9411731594268109371526', SERVICE = 'https://trawl.invalid';
const SECRET = 'SYNTHETIC-VERIFICATION-RESPONSE-DO-NOT-RETAIN';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const capture = (status: number, extra: Record<string, unknown> = {}) => ({ url: westernBidApiUrl(NUMBER), status, headers: {}, body: null, error: 'body size is unknown; body was not read safely', ...extra });
const page = (html = fixture(), extra: Record<string, unknown> = {}) => response({ url: westernBidTrackingUrl(NUMBER), tier: 3, statusCode: 200, html,
  cookies: [{ name: 'guest_sid', value: SECRET, domain: '.westparcel.com', path: '/' }], capturedResponses: [capture(200)], ...extra });
function harness(reply = page()) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new WesternBidTracker({ fetcher, recorder, trawl: new TrawlClient(SERVICE) }) };
}

describe('Western Bid verified guest retrieval', () => {
  it('uses the bound deep link and captures the whole-number request before rendering', async () => {
    const h = harness();
    const result = await h.tracker.fetch(NUMBER);
    expect(result).toMatchObject({ status: 'delivered', history_truncated: true });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SERVICE}/scrape`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init!.body))).toMatchObject({ url: westernBidTrackingUrl(NUMBER), skipHttp: true, maxTier: 3,
      contentWaitForSelector: WESTERN_BID_READY, captureResponses: [westernBidApiUrl(NUMBER)] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'trawl', outcome: 'ok' }));
    expect(h.recorder.lookup).toHaveBeenCalledWith(expect.objectContaining({ attempts: 1, finalStep: 'trawl', outcome: 'ok' }));
  });

  it('confirms an explicitly listed alias without claiming a broader detection shape', async () => {
    const h = harness(page(fixture(), { url: westernBidTrackingUrl(ALIAS), capturedResponses: [capture(200, { url: westernBidApiUrl(ALIAS) })] }));
    await expect(h.tracker.fetch(ALIAS)).resolves.toMatchObject({ canonical_tracking_number: NUMBER, status: 'delivered' });
  });

  it('keeps only the bound explicit missing-parcel notice as not found', async () => {
    await expect(harness(page(fixture('not-found'))).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([401, 403, 404, 410, 429, 503])('does not hide the latest captured HTTP %s behind an older rendered success', async status => {
    const h = harness(page(fixture(), { capturedResponses: [capture(200), capture(status, { headers: { 'retry-after': '9' }, body: SECRET })] }));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: [401, 403].includes(status) ? 'challenge' : status === 429 ? 'rate_limited' : 'transport', status });
    if (status === 429) expect(error).toHaveProperty('retryAfterMs', 9000);
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
  });

  it('accepts a later verified response and ignores unrelated capture statuses', async () => {
    const h = harness(page(fixture(), { capturedResponses: [capture(403), capture(200), capture(429, { url: westernBidApiUrl(NUMBER) + '4' })] }));
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
  });

  it('rejects foreign and missing response URLs before reading the shipment', async () => {
    for (const extra of [{ url: 'https://other.invalid/' }, { url: undefined }]) {
      await expect(harness(page(fixture(), extra)).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    }
  });

  it('removes arbitrary service diagnostics and causes containing verification values', async () => {
    const h = harness(response({ error: `${SECRET} https://carrier.invalid/?token=${SECRET}` }, 500));
    let error: unknown;
    try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(`${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`).not.toContain(SECRET);
    expect((error as Error).cause).toBeUndefined();
  });

  it('requires TRAWL and never enters a browser through HTTP recognition', async () => {
    await expect(new WesternBidTracker().fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    const h = harness();
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, env: {}, trawl: new TrawlClient(SERVICE), browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('reserves transport time within the shared budget and never starts after cancellation', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(new Error('Cancelled'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Cancelled');
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
