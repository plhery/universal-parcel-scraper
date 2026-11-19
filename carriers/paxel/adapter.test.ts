import { describe, expect, it, vi } from 'vitest';
import type { AdapterEnvironment } from '../../core/adapter/index.js';
import { UpstreamHttpError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient, type TrawlCapturedResponse, type TrawlCallOptions, type TrawlScrapeRequest, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { adapter, PaxelTracker } from './adapter.js';
import { PAGE } from './parser.js';

const NUMBER = 'TSPX-12345678901';
const html = `<div class="awb-detail"><h5>${NUMBER}</h5><h6>${NUMBER}</h6><div class="delivery-timeline">
  <div class="row"><div class="district">FACILITY</div><div class="col-3">Nov 06 | 21:08</div></div>
  <div class="description">Paketmu telah berhasil diantar oleh Hero SYNTHETIC STAFF</div></div></div>`;
const capture = (extra: Partial<TrawlCapturedResponse> = {}): TrawlCapturedResponse => ({ url: PAGE, status: 200, headers: {}, body: html,
  error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER, ...extra });

function harness(rows = [capture()], extra: Partial<TrawlScrapeResponse> = {}) {
  const calls: { request: TrawlScrapeRequest; options: TrawlCallOptions }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected fixture egress'));
  class FixtureTrawl extends TrawlClient {
    override async scrape(request: TrawlScrapeRequest, options: TrawlCallOptions): Promise<TrawlScrapeResponse> {
      calls.push({ request, options });
      return { url: request.url, html: '', cookies: [], userAgent: null, tier: 3, statusCode: 200, raw: {}, capturedResponses: rows, ...extra };
    }
  }
  const recorder = { ...NOOP_RECORDER, step: vi.fn() };
  const environment: AdapterEnvironment = { fetcher, trawl: new FixtureTrawl('https://trawl.invalid'), browserExecutablePath: null, recorder, env: {} };
  return { calls, fetcher, environment, recorder, tracker: new PaxelTracker(environment) };
}

describe('Paxel supplied browser boundary', () => {
  it('uses one supplied browser step, printed whole binding, signal, fetcher and a transport reserve', async () => {
    const h = harness([capture({ trackingNumberSubmitted: undefined, status: 403, body: null }), capture()]);
    const result = await h.tracker.fetch(NUMBER.replace('-', ''), { budgetMs: 20_000 });
    expect(result).toMatchObject({ current_stage: 'delivered', history_truncated: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.request).toMatchObject({ url: PAGE + '?awb_req=' + NUMBER, captureResponses: [PAGE], skipHttp: true, maxTier: 3 });
    expect(h.calls[0]?.request.maxTimeout).toBeGreaterThanOrEqual(1000);
    expect(h.calls[0]?.request.maxTimeout).toBeLessThanOrEqual(5000);
    expect(h.calls[0]?.options).toMatchObject({ fetcher: h.fetcher, requireSolved: false, captureWindow: 'first' });
    expect(h.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'paxel', step: 'trawl', outcome: 'ok' }));
    const a = adapter(h.environment);
    expect(a).toMatchObject({ id: 'paxel', steps: ['trawl'], recordsSteps: true });
    expect(a.recognize).toBeUndefined(); expect(a.recognizeWithBrowser).toBeUndefined();
  });

  it.each([
    [{ status: 403 }, 'challenge'], [{ status: 401 }, 'challenge'], [{ status: 428 }, 'challenge'],
    [{ status: 429, headers: { 'Retry-After': '120' } }, 'rate_limited'], [{ status: 503 }, 'maintenance'],
    [{ status: 500 }, 'indeterminate'], [{ status: 400 }, 'transport'], [{ status: 404 }, 'transport'], [{ status: 410 }, 'transport'],
    [{ status: 0 }, 'transport'], [{ error: 'body-read' }, 'transport'], [{ truncated: true }, 'transport'],
    [{ base64Encoded: true }, 'transport'], [{ body: null }, 'transport'], [{ error: 'challenge-html' }, 'challenge'],
    [{ body: 'TokenMismatchException' }, 'schema'], [{ headers: { 'Content-Type': 'application/json' } }, 'schema'],
  ] as const)('preserves captured failure categories: %j', async (extra, kind) => {
    await expect(harness([capture(extra)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('reads numeric and HTTP-date retry-after case-insensitively', async () => {
    await expect(harness([capture({ status: 429, headers: { 'Retry-After': '120' } })]).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T10:00:00Z'));
    try {
      await expect(harness([capture({ status: 429, headers: { 'RETRY-AFTER': 'Wed, 18 Nov 2026 10:00:30 GMT' } })]).tracker.fetch(NUMBER))
        .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    } finally { clock.mockRestore(); }
  });

  it('requires exact submitted metadata, exact endpoint, one bound reply and a bounded sequence', async () => {
    for (const rows of [[capture({ trackingNumberSubmitted: 'TSPX-99999999999' })], [capture({ url: PAGE + '/other' })],
      [capture(), capture()], Array.from({ length: 13 }, () => capture({ trackingNumberSubmitted: undefined }))]) {
      await expect(harness(rows).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    }
    await expect(harness([capture({ trackingNumberSubmitted: undefined })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', reason: 'capture_missing' });
    await expect(harness(undefined, { url: 'https://paxel.co/elsewhere' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('distinguishes unfinished verification from missing capture and endpoint refusal', async () => {
    await expect(harness([], { raw: { timings: [{ reason: 'paxel-verification_unfinished' }] } }).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge', reason: 'verification_unfinished' });
    await expect(harness([], { raw: { timings: [{ reason: 'paxel-capture_missing' }] } }).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'transport', reason: 'capture_missing' });
    await expect(harness([], { statusCode: 403 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], { statusCode: 404 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], { statusCode: 503 }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(harness([], { statusCode: 429, raw: { responseHeaders: { 'Retry-After': '12' } } }).tracker.fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12_000 });
  });

  it('reads a redirect answer to the bound form POST as a transport failure, never a missing parcel', async () => {
    // The browser cannot read a redirect's body, so the helper reports it unreadable.
    for (const reply of [capture({ status: 302, body: null, error: 'body_unreadable' }), capture({ status: 302, body: '' })]) {
      await expect(harness([reply]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 302 });
    }
  });

  it('retains the invalid-AWB uncertainty at the adapter boundary', async () => {
    const body = `<table><tbody><tr><td>${NUMBER}</td><td><span class="tx-red">AWB Tidak Valid</span></td></tr></tbody></table>`;
    await expect(harness([capture({ body })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'invalid_awb' });
  });

  it('cancels before dispatch and after a reply without accepting stale work', async () => {
    const h = harness(), controller = new AbortController(), reason = new Error('Synthetic caller cancellation'); controller.abort(reason);
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(h.calls).toHaveLength(0);
    const late = harness(), second = new AbortController();
    late.environment.trawl!.scrape = async () => { second.abort(reason); return { url: PAGE, html: '', tier: 3, statusCode: 200,
      userAgent: null, cookies: [], capturedResponses: [capture()], raw: {} }; };
    await expect(late.tracker.fetch(NUMBER, { signal: second.signal })).rejects.toBe(reason);
  });

  it('keeps unavailable browser configuration and insufficient budget explicit', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 100 })).rejects.toMatchObject({ kind: 'budget' });
    expect(h.calls).toHaveLength(0);
    h.environment.trawl = null;
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps a service deadline to budget and drops service request diagnostics', async () => {
    const h = harness();
    h.environment.trawl!.scrape = async () => { throw new UpstreamHttpError('TRAWL', 500, undefined,
      { body_excerpt: '{"error":"Scrape deadline exceeded"}' } as never); };
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'budget' });
    h.environment.trawl!.scrape = async () => { throw new UpstreamHttpError('TRAWL', 503, undefined,
      { body_excerpt: 'SYNTHETIC SECRET' } as never); };
    const error: unknown = await h.tracker.fetch(NUMBER).catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'maintenance' });
    expect(JSON.stringify(error)).not.toContain('SYNTHETIC SECRET');
    h.environment.trawl!.scrape = async () => { throw new UpstreamHttpError('TRAWL', 404); };
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 404 });
  });
});
