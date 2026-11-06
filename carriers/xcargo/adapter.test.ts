import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER, type StepRecord } from '../../core/telemetry/index.js';
import { adapter, XcargoTracker } from './adapter.js';
import { MAX_BYTES, WIDGET_URL, xcargoUrl } from './parser.js';

const NUMBER = '9000000000000017';
const body = () => readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const absent = () => readFileSync(new URL('./fixtures/unknown.json', import.meta.url), 'utf8');
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url') + '.SYNTHETIC_SIGNATURE'; // Synthetic guest token. gitleaks:allow
const widget = () => new Response('const visitor="' + TOKEN + '";', { headers: { 'Content-Type': 'application/javascript' } });
const json = (value = body(), status = 200, headers: Record<string, string> = {}) =>
  new Response(value, { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('X-Cargo guest adapter', () => {
  it('reads fresh public configuration then the whole reference through supplied transport', async () => {
    const read = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockResolvedValueOnce(json());
    const result = await new XcargoTracker({ fetcher: read, userAgent: 'Configured Agent' }).fetch('9000 0000 0000 0017');
    expect(result.current_stage).toBe('delivered'); expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.map(([url]) => String(url))).toEqual([WIDGET_URL, xcargoUrl(NUMBER)]);
    for (const [, init] of read.mock.calls) {
      expect(init?.redirect).toBe('manual'); expect(init?.body).toBeUndefined(); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('Configured Agent');
    }
    expect(new Headers(read.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false);
    expect(new Headers(read.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer ' + TOKEN);
    expect(new Headers(read.mock.calls[1]![1]?.headers).get('Origin')).toBe('https://x-cargo.co');
  });

  it('returns definite absence only for the exact history404, not configuration404', async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockResolvedValueOnce(json(absent(), 404));
    await expect(new XcargoTracker({ fetcher: missing }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(json(absent(), 404));
    await expect(new XcargoTracker({ fetcher: unavailable }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('does not turn a malformed history404 into a missing parcel', async () => {
    for (const value of ['null', '"missing"', '42', '[]']) {
      const read = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockResolvedValueOnce(json(value, 404));
      await expect(new XcargoTracker({ fetcher: read }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
      expect(read).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps shared numeric inputs out of recognition and rejects unsupported named handoffs before HTTP', async () => {
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('xcargo');
    const read = vi.fn<typeof fetch>();
    const a = adapter({ fetcher: read, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(a.steps).toEqual(['direct', 'retry']); expect(a.recordsSteps).toBe(true); expect(a.recognize).toBeUndefined();
    expect(hasDirectHandoffAdapter('xcargo', NUMBER)).toBe(true);
    for (const number of ['123456789012345', '12345678901234567', 'CO123456789CO']) {
      expect(hasDirectHandoffAdapter('xcargo', number)).toBe(false);
      await expect(a.track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('does not retry verification, rate limits, redirects, broken JSON or another response identity', async () => {
    const badRoute = json(); Object.defineProperty(badRoute, 'url', { value: 'https://api.bigsmart.mx/api/order-logs/other' });
    for (const [response, kind] of [
      [json('', 401), 'challenge'], [json('', 403), 'challenge'], [json('', 428), 'challenge'],
      [json('', 200, { 'cf-mitigated': 'challenge' }), 'challenge'], [new Response('<title>Just a moment</title>'), 'challenge'],
      [json('{}', 429, { 'Retry-After': '90' }), 'rate_limited'], [json('', 302, { Location: '/login' }), 'transport'],
      [json('malformed'), 'schema'], [json('<html/>', 200, { 'Content-Type': 'text/html' }), 'schema'], [badRoute, 'schema'],
    ] as const) {
      const read = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockResolvedValueOnce(response);
      await expect(new XcargoTracker({ fetcher: read }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(read).toHaveBeenCalledTimes(2);
    }
  });

  it('retains error kinds/retry windows without public bearer, reference or response diagnostics', async () => {
    const read = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockResolvedValueOnce(json('SYNTHETIC_PRIVATE_BODY', 429, { 'Retry-After': '90' }));
    try { await new XcargoTracker({ fetcher: read }).fetch(NUMBER); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 90000 });
      expect(JSON.stringify(error)).not.toMatch(/SYNTHETIC|9000000000000017|Bearer|eyJ|https?:|authorization/i);
    }
  });

  it('restarts the whole guest flow only after a network failure and records both steps', async () => {
    const read = vi.fn<typeof fetch>().mockResolvedValueOnce(widget()).mockRejectedValueOnce(new TypeError('SYNTHETIC_NETWORK_DETAIL'))
      .mockResolvedValueOnce(widget()).mockResolvedValueOnce(json());
    const steps: StepRecord[] = [];
    await expect(new XcargoTracker({ fetcher: read, recorder: { step: s => { steps.push(s); }, lookup() {} } }).fetch(NUMBER, { budgetMs: 1000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(read.mock.calls.map(([url]) => String(url))).toEqual([WIDGET_URL, xcargoUrl(NUMBER), WIDGET_URL, xcargoUrl(NUMBER)]);
    expect(steps.map(s => s.step)).toEqual(['direct', 'retry']); expect(steps[0]?.errorType).toBe('UpstreamNetworkError');
  });

  it('starts no history after caller cancellation and bounds each returned body', async () => {
    const controller = new AbortController();
    const read = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(new Error('caller stopped')); return widget(); });
    await expect(new XcargoTracker({ fetcher: read }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('caller stopped');
    expect(read).toHaveBeenCalledTimes(1);
    const big = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { headers: { 'Content-Length': String(MAX_BYTES + 1) } }));
    await expect(new XcargoTracker({ fetcher: big }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(big).toHaveBeenCalledTimes(1);
  });
});
