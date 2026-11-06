import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { parseTrackingInput } from '../../core/detection/parse.js';
import { isSkladusaReference } from '../../core/detection/skladusa.js';
import { NOOP_RECORDER, type StepRecord } from '../../core/telemetry/index.js';
import { adapter, SkladusaTracker } from './adapter.js';
import { MAX_BYTES, skladusaTrackingUrl } from './parser.js';

const NUMBER = 'SK1000000017UA';
const fixture = (name = 'delivered') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body = fixture(), status = 200, headers: Record<string, string> = {}, url = skladusaTrackingUrl(NUMBER)) => {
  const response = new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
  if (headers['Set-Cookie']) Object.defineProperty(response, 'url', { value: url });
  return response;
};
const ukrainian = (body = fixture()) => body.replaceAll('/en/tracking/', '/tracking/').replace('Search result:', 'Результат пошуку:')
  .replace('<th>Data</th>', '<th>Дата</th>').replace('<th>Status</th>', '<th>Статус</th>')
  .replace('<th>More details</th>', '<th>Детальніше</th>').replace('No tracking info yet', 'Ще немає інформації про відстеження');

describe('SkladUSA public guest HTTP adapter', () => {
  it('sends one canonical whole-reference GET through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    const result = await new SkladusaTracker({ fetcher, userAgent: 'Supplied Agent' }).fetch(' sk 1000000017 ua ');
    expect(result.current_stage).toBe('delivered'); expect(result.events!.length).toBeGreaterThan(2);
    expect(result.events!.every(event => event.local_time && !event.event_time && !event.provider_code)).toBe(true);
    expect(result.delivery_carrier).toBeUndefined(); expect(result.delivery_tracking_number).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://skladusa.com/en/tracking/sk1000000017ua/');
    expect(url).toBe(skladusaTrackingUrl(NUMBER)); expect(init?.redirect).toBe('manual'); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('User-Agent')).toBe('Supplied Agent');
    expect(new Headers(init?.headers).get('Accept-Language')).toBe('en-GB,en;q=0.9');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retains fresh guest cookies through the observed language and slash redirects', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply('', 301, { Location: '/tracking/sk1000000017ua',
        'Set-Cookie': 'advanced-frontend=SYNTHETIC_GUEST; Path=/; Secure; HttpOnly' }))
      .mockResolvedValueOnce(reply('', 301, { Location: '/tracking/sk1000000017ua/' }))
      .mockResolvedValueOnce(reply(ukrainian()));
    const tracker = new SkladusaTracker({ fetcher });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      skladusaTrackingUrl(NUMBER), 'https://skladusa.com/tracking/sk1000000017ua', 'https://skladusa.com/tracking/sk1000000017ua/',
    ]);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('Cookie')).toBe(false);
    for (const [, init] of fetcher.mock.calls.slice(1)) expect(new Headers(init?.headers).get('Cookie')).toBe('advanced-frontend=SYNTHETIC_GUEST');
    fetcher.mockResolvedValueOnce(reply());
    await tracker.fetch(NUMBER);
    expect(new Headers(fetcher.mock.calls[3]![1]?.headers).has('Cookie')).toBe(false);
  });

  it('keeps the localized empty result indeterminate after a scoped guest redirect', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply('', 301, { Location: '/tracking/sk1000000017ua/' }))
      .mockResolvedValueOnce(reply(ukrainian(fixture('empty'))));
    await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'expired_or_unknown' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never follows another host, reference, query, account route or unbounded redirect cycle', async () => {
    for (const location of ['https://example.invalid/tracking/sk1000000017ua/', '/tracking/sk1000000018ua/',
      '/tracking/sk1000000017ua/?key=SYNTHETIC', '/tracking/sk1000000017ua/#fragment', '/en/login/',
      'https://user:password@skladusa.com/tracking/sk1000000017ua/', 'http://skladusa.com/tracking/sk1000000017ua/']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('', 301, { Location: location }));
      await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const loop = vi.fn<typeof fetch>().mockImplementation(async () => reply('', 301, { Location: '/tracking/sk1000000017ua/' }));
    await expect(new SkladusaTracker({ fetcher: loop }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it('stops verification on redirects and strips guest state from errors', async () => {
    const blocked = vi.fn<typeof fetch>().mockResolvedValue(reply('<title>Just a moment</title>', 301, { Location: '/tracking/sk1000000017ua/' }));
    await expect(new SkladusaTracker({ fetcher: blocked }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(blocked).toHaveBeenCalledTimes(1);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (!new Headers(init?.headers).has('Cookie')) return reply('', 301, { Location: '/tracking/sk1000000017ua/',
        'Set-Cookie': 'advanced-frontend=SYNTHETIC_GUEST; Path=/; Secure' });
      return reply('SYNTHETIC_PRIVATE_REPLY', 429, { 'Retry-After': '60', 'Set-Cookie': 'private=SYNTHETIC_SECRET' }, 'https://skladusa.com/tracking/sk1000000017ua/');
    });
    try { await new SkladusaTracker({ fetcher }).fetch(NUMBER); throw new Error('Expected rejection'); }
    catch (error) {
      expect(error).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
      expect(JSON.stringify(error)).not.toMatch(/SYNTHETIC|1000000017|cookie|https?:/i);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps unknown or unretained history indeterminate without a second request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('empty')));
    await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'expired_or_unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses narrow selection and handoff eligibility without adding recognition', async () => {
    expect(isSkladusaReference(NUMBER)).toBe(true);
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('skladusa');
    const fetcher = vi.fn<typeof fetch>();
    const factory = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(factory.id).toBe('skladusa'); expect(factory.steps).toEqual(['direct', 'retry']); expect(factory.recordsSteps).toBe(true);
    expect(factory.recognize).toBeUndefined();
    for (const raw of ['SK10000000170UA', 'SK100000001UA', 'SK1000000017US', '7030000000000001', NUMBER + '/' + NUMBER]) {
      expect(isSkladusaReference(raw)).toBe(false);
      await expect(factory.track({ number: raw })).rejects.toMatchObject({ kind: 'invalid_input' });
      expect(hasDirectHandoffAdapter('skladusa', raw)).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(hasDirectHandoffAdapter('skladusa', NUMBER)).toBe(true);
    expect(deliveryHandoff('yanwen', 'YW0000000000', {
      delivery_carrier: 'skladusa', delivery_tracking_number: '7030000000000001',
    })).toBeNull();
  });

  it('preserves issuer detection for unsupported references in portal links', () => {
    for (const prefix of ['/en/tracking/', '/tracking/']) {
      expect(parseTrackingInput('https://skladusa.com' + prefix + NUMBER.toLowerCase() + '/'))
        .toMatchObject({ trackingNumber: NUMBER.toLowerCase(), carrier: 'skladusa', source: 'link' });
      const foreign = parseTrackingInput('https://skladusa.com' + prefix + '7030000000000001/');
      expect(foreign.trackingNumber).toBe('7030000000000001'); expect(foreign.carrier).not.toBe('skladusa');
      expect(foreign.carrier).toBe(parseTrackingInput('7030000000000001').carrier);
    }
  });

  it('never treats refusals, redirects, rate limits or schema errors as an absent shipment', async () => {
    for (const [response, kind] of [
      [reply('', 401), 'challenge'], [reply('', 403), 'challenge'], [reply('', 428), 'challenge'],
      [reply('', 200, { 'cf-mitigated': 'challenge' }), 'challenge'],
      [reply('<title>Just a moment</title><div>Verify you are human</div>'), 'challenge'],
      [reply('', 429, { 'Retry-After': '60' }), 'rate_limited'], [reply('', 404), 'transport'],
      [new Response(null, { status: 302, headers: { Location: '/en/tracking/' } }), 'transport'],
      [reply('{}', 200, { 'Content-Type': 'application/json' }), 'schema'],
      [reply('<h1>Tracking unavailable</h1>'), 'schema'],
    ] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a different final route before projecting plausible history', async () => {
    const response = reply(); Object.defineProperty(response, 'url', { value: 'https://skladusa.com/en/tracking/' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records one network-only retry within the caller budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    const steps: StepRecord[] = [];
    const tracker = new SkladusaTracker({ fetcher, recorder: { step: step => { steps.push(step); }, lookup() {} } });
    await expect(tracker.fetch(NUMBER, { budgetMs: 1000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(steps.map(step => step.step)).toEqual(['direct', 'retry']);
    expect(steps[0]?.errorType).toBe('UpstreamNetworkError');
  });

  it('bounds oversized replies and starts no request after cancellation', async () => {
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(reply('', 200, { 'Content-Length': String(MAX_BYTES + 1) }));
    await expect(new SkladusaTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow();
    expect(oversized).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    await expect(new SkladusaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds aggregate redirect bytes and restarts a failed guest session without its cookies', async () => {
    const big = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply('x'.repeat(MAX_BYTES / 2), 301, { Location: '/tracking/sk1000000017ua/' }))
      .mockResolvedValueOnce(reply('', 200, { 'Content-Length': String(MAX_BYTES / 2 + 1) }));
    await expect(new SkladusaTracker({ fetcher: big }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(big).toHaveBeenCalledTimes(2);
    const retry = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply('', 301, { Location: '/tracking/sk1000000017ua/', 'Set-Cookie': 'advanced-frontend=SYNTHETIC_GUEST; Secure; Path=/' }))
      .mockRejectedValueOnce(new TypeError('SYNTHETIC_NETWORK_SECRET'))
      .mockResolvedValueOnce(reply());
    await expect(new SkladusaTracker({ fetcher: retry }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(retry).toHaveBeenCalledTimes(3);
    expect(new Headers(retry.mock.calls[1]![1]?.headers).has('Cookie')).toBe(true);
    expect(new Headers(retry.mock.calls[2]![1]?.headers).has('Cookie')).toBe(false);
  });
});
