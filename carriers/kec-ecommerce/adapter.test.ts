import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, KEC_API, KecTracker } from './adapter.js';
import { KEC_MAX_BYTES } from './parser.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const NUMBER = 'KECSYNTH39057186240';
const reply = (body: unknown = fixture(), status = 200, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json', ...headers } });
function harness(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
  return { fetcher, recorder, tracker: new KecTracker({ fetcher, recorder, userAgent: 'Synthetic tracking host' }) };
}

describe('KEC eCommerce native guest transport', () => {
  it('uses the whole number, official guest request and supplied user agent', async () => {
    const h = harness(reply());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${KEC_API}?tracking_number=${NUMBER}`);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: {
      Accept: 'application/json', authorization: expect.any(String), 'User-Agent': 'Synthetic tracking host',
      Origin: 'https://kec.kln.com', Referer: 'https://kec.kln.com/en/logistics-tracking/',
    } });
    expect(h.recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'direct', outcome: 'ok' }));
  });

  it('retries only a network failure and retains its step provenance', async () => {
    const h = harness();
    h.fetcher.mockRejectedValueOnce(new TypeError('SYNTHETIC PRIVATE CONNECTION')).mockResolvedValueOnce(reply());
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ status: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(h.recorder.step.mock.calls.map(([event]) => [event.step, event.outcome, event.fallbackFrom]))
      .toEqual([['direct', 'transport', null], ['retry', 'ok', 'direct']]);
    expect(h.fetcher.mock.calls.every(([, init]) => init!.signal instanceof AbortSignal)).toBe(true);
    const telemetry = JSON.stringify(h.recorder.step.mock.calls);
    expect(telemetry).not.toContain('SYNTHETIC PRIVATE CONNECTION');
    expect(telemetry).not.toContain(NUMBER);
    expect(telemetry).not.toContain(new Headers(h.fetcher.mock.calls[0]![1]!.headers).get('authorization'));
  });

  it.each([301, 302, 303, 307, 308, 404, 405, 410])('keeps unavailable HTTP %s separate from a missing parcel', async status => {
    const h = harness(reply('SYNTHETIC PRIVATE RESPONSE', status));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('stops at HTTP %s without another request', async status => {
    const h = harness(reply('SYNTHETIC PRIVATE RESPONSE', status));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', status });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.recorder.step.mock.calls)).not.toContain('SYNTHETIC PRIVATE');
  });

  it('keeps an unknown HTTP 500 inconclusive and drops trace and credential diagnostics', async () => {
    const h = harness(reply({ status: 500, msg: 'SYNTHETIC PRIVATE MESSAGE', trace: ['SYNTHETIC PRIVATE TRACE'], data: null }, 500));
    let error: unknown; try { await h.tracker.fetch(NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const telemetry = `${String(error)}${JSON.stringify(error)}${JSON.stringify(h.recorder.step.mock.calls)}`;
    expect(telemetry).not.toContain('SYNTHETIC PRIVATE');
    expect(telemetry).not.toContain(NUMBER);
    expect(telemetry).not.toContain(new Headers(h.fetcher.mock.calls[0]![1]!.headers).get('authorization'));
    expect(error).toHaveProperty('request', undefined);
    expect(error).toHaveProperty('diagnostics', undefined);
  });

  it('preserves rate-limit kind and Retry-After without retrying', async () => {
    const h = harness(reply('SYNTHETIC PRIVATE', 429, { 'retry-after': '9' }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs: 9000 });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['<html><title>Just a moment...</title></html>', 'challenge'],
    ['<html><title>Tracking CAPTCHA</title></html>', 'challenge'],
    ['<html>Changed page SYNTHETIC PRIVATE</html>', 'schema'],
    ['{ invalid SYNTHETIC PRIVATE', 'schema'],
  ])('classifies blocked and malformed replies without retaining the body', async (body, kind) => {
    const h = harness(reply(body));
    await expect(h.tracker.fetch(NUMBER)).rejects.toHaveProperty('kind', kind);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.recorder.step.mock.calls)).not.toContain('SYNTHETIC PRIVATE');
  });

  it('cancels an oversized response while reading and keeps the size reason', async () => {
    const cancel = vi.fn(), stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(KEC_MAX_BYTES + 1)); }, cancel });
    const h = harness(new Response(stream));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('passes cancellation into an ongoing request and starts no retry', async () => {
    const h = harness(), controller = new AbortController();
    h.fetcher.mockImplementationOnce(async (_url, init) => {
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error('Synthetic caller cancellation'));
      init!.signal!.throwIfAborted();
      return reply();
    });
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal, budgetMs: 1000 })).rejects.toThrow('Synthetic caller cancellation');
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it('starts nothing for cancelled, spent-budget or invalid input', async () => {
    const h = harness(), controller = new AbortController(); controller.abort(new Error('Synthetic caller cancellation'));
    await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow('Synthetic caller cancellation');
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    await expect(h.tracker.fetch('A,B')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it('adds no recognition and uses only the supplied HTTP transport', async () => {
    const h = harness(reply());
    const native = adapter({ fetcher: h.fetcher, recorder: h.recorder, userAgent: 'Synthetic host', env: {}, trawl: null, browserExecutablePath: null });
    expect(native.recognize).toBeUndefined();
    expect(native.recognizeWithBrowser).toBeUndefined();
    expect(native.steps).toEqual(['direct', 'retry']);
    await expect(native.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
  });
});
