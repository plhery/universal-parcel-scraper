import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { detectCarrierMatch } from '../../core/detection/detect.js';
import { isPostOneReference } from '../../core/detection/postOne.js';
import { parseTrackingInput } from '../../core/detection/parse.js';
import { NOOP_RECORDER, type StepRecord } from '../../core/telemetry/index.js';
import { adapter, PostOneTracker } from './adapter.js';
import { MAX_BYTES, postOneTrackingUrl } from './parser.js';

const NUMBER = 'R1000000017';
const fixture = () => readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const htmlResponse = (body = fixture(), status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const missing = (location = '/en', body = '') => new Response(body, { status: 302, headers: { Location: location } });

describe('Post One HTTP tracking and recognition', () => {
  it('uses the complete official query, supplied transport and language without following redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse());
    const result = await new PostOneTracker({ fetcher, userAgent: 'Supplied Agent' }).fetch(' r 1000000017 ');
    expect(result.current_stage).toBe('delivered'); expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://postone.eu/en/track?code=' + NUMBER);
    expect(url).toBe(postOneTrackingUrl(NUMBER));
    expect(init?.redirect).toBe('manual'); expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ 'User-Agent': 'Supplied Agent', 'Accept-Language': 'en-GB' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('asks HTTP recognition for the shared own shape without assigning an issuer from shape alone', async () => {
    const meta = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    expect(meta.detection).toEqual([{ id: 'post-one-1', pattern: '^R\\d{10}$', confidence: 'low' }]);
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ confidence: 'low', candidates: expect.arrayContaining(['post-one', 'gls-it']) });
    expect(recognitionAskedCarriers(NUMBER)).toContain('post-one');
    const pattern = new RegExp(meta.tracking.recognition.pattern);
    expect(pattern.test(NUMBER) && isPostOneReference(NUMBER)).toBe(true);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse());
    const factory = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    for (const input of ['R10000000170', 'A1000000017', '70312345678901', 'RR000000000BG', 'R1000000017/R1000000018']) {
      expect(pattern.test(input) || isPostOneReference(input)).toBe(false);
      await expect(factory.recognize!(input)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(factory.recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: null,
      lastActivityLocal: expect.any(String) });
    expect(factory.steps).toEqual(['direct', 'retry']); expect(factory.recordsSteps).toBe(true);
  });

  it('keeps partner portal links with their issuer instead of forcing the Post One brand', () => {
    expect(parseTrackingInput(postOneTrackingUrl(NUMBER))).toMatchObject({ trackingNumber: NUMBER, carrier: 'post-one', source: 'link' });
    const partner = parseTrackingInput('https://postone.eu/en/track?code=70312345678901');
    expect(partner.trackingNumber).toBe('70312345678901'); expect(partner.carrier).not.toBe('post-one');
    expect(recognitionAskedCarriers('70312345678901')).not.toContain('post-one');
  });

  it('proposes named Post One handoffs only for references its adapter can actually read', () => {
    expect(hasDirectHandoffAdapter('post-one', NUMBER)).toBe(true);
    expect(hasDirectHandoffAdapter('post-one', '7030000000000001')).toBe(false);
    expect(deliveryHandoff('yanwen', 'YW0000000000', {
      delivery_carrier: 'post-one', delivery_tracking_number: '7030000000000001',
    })).toBeNull();
    expect(deliveryHandoff('yanwen', 'YW0000000000', {
      delivery_carrier: 'post-one', delivery_tracking_number: NUMBER,
    })).toEqual({ carrier: 'post-one', number: NUMBER, basis: 'partner' });
  });

  it('recognizes only the exact empty official-home redirect as absence', async () => {
    for (const location of ['/en', 'https://postone.eu/en']) {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => missing(location));
      const tracker = new PostOneTracker({ fetcher });
      await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: false });
    }
  });

  it('recognizes a bound item whose reached history is empty without inventing scans', async () => {
    const $ = load(fixture()); $('.col-md-4').empty();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => htmlResponse($.html()));
    const tracker = new PostOneTracker({ fetcher });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'parcel_found' });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null });
  });

  it('keeps other redirects and nonempty interstitials distinct from absence', async () => {
    const replies = [missing('/en?challenge=1'), missing('/en/'), missing('//example.invalid/en'),
      missing('http://postone.eu/en'), missing('/en', '<title>Verify access</title>'),
      new Response(null, { status: 301, headers: { Location: '/en' } }),
      new Response(null, { status: 303, headers: { Location: '/en' } })];
    for (const response of replies) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new PostOneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a substituted response route before trusting history or absence', async () => {
    for (const response of [htmlResponse(), missing()]) {
      Object.defineProperty(response, 'url', { value: 'https://postone.eu/en' });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new PostOneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('preserves challenges, rate limits, route failures and malformed replies without repeating them', async () => {
    for (const status of [401, 403, 428]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('', status));
      await expect(new PostOneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const challengedRedirect = missing('/en'); challengedRedirect.headers.set('cf-mitigated', 'challenge');
    for (const [response, kind] of [[challengedRedirect, 'challenge'],
      [htmlResponse('<title>Just a moment</title><div>verify you are human</div>'), 'challenge'],
      [htmlResponse('', 429, { 'Retry-After': '60' }), 'rate_limited'],
      [htmlResponse('', 404), 'transport'],
      [htmlResponse('{}', 200, { 'Content-Type': 'application/json' }), 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new PostOneTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('records one network-only retry inside the same lookup budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(htmlResponse());
    const steps: StepRecord[] = [];
    const tracker = new PostOneTracker({ fetcher, recorder: { step: step => { steps.push(step); }, lookup() {} } });
    await expect(tracker.fetch(NUMBER, { budgetMs: 1000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(steps.map(step => step.step)).toEqual(['direct', 'retry']);
    expect(steps[0]?.errorType).toBe('UpstreamNetworkError');
  });

  it('rejects oversized replies and pre-aborts without a recovery request', async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('', 200, { 'Content-Length': String(MAX_BYTES + 1) }));
    await expect(new PostOneTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow();
    expect(oversized).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(new PostOneTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
