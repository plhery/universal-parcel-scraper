import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { TrawlClient, TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { adapter, JS_EXPRESS_TRACKER, JsExpressTracker } from './adapter.js';
import { parseJsExpress } from './parser.js';

const NUMBER = 'JSEZZ0000000001YQ';
const OTHER = 'JSEZZ0000000002YQ';
const URL = `${JS_EXPRESS_TRACKER}&card_num=${NUMBER}`;
const json = readFileSync(new globalThis.URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const missing = readFileSync(new globalThis.URL('./fixtures/not-found.json', import.meta.url), 'utf8');
const blocked = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const document = (text: string) => `<html><head></head><body>${escape(text)}</body></html>`;
const response = (body: string, status = 200) => new Response(body, { status });
const page = (html: string, url = URL): TrawlScrapeResponse => ({
  url, html, cookies: [], userAgent: null, tier: 3, statusCode: 200, capturedResponses: [], raw: {},
});
const browser = (html = document(json), url = URL) => {
  const scrape = vi.fn<TrawlClient['scrape']>().mockResolvedValue(page(html, url));
  return { trawl: { scrape } as unknown as TrawlClient, scrape };
};

describe('JS Express browser recovery', () => {
  it('declares browser-capable retrieval without enabling browser recognition', () => {
    expect(CARRIER_DEFINITIONS['js-express'].tracking.browser).toBe(true);
    expect(CARRIER_DEFINITIONS['js-express'].tracking.browserRecognitionRank).toBeUndefined();
  });

  it('recovers a refused HTTP lookup through the whole-number guest GET and records the failure', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
    const { trawl, scrape } = browser();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new JsExpressTracker({ fetcher, trawl, recorder }).fetch(NUMBER, { budgetMs: 40_000 });
    expect(result).toEqual(parseJsExpress(JSON.parse(json), NUMBER));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape).toHaveBeenCalledWith({ url: URL, skipHttp: true, maxTier: 3, maxTimeout: expect.any(Number) },
      expect.objectContaining({ signal: expect.any(AbortSignal), fetcher, timeoutMs: expect.any(Number) }));
    expect(scrape.mock.calls[0]![0].maxTimeout).toBeLessThan(25_001);
    expect(recorder.step.mock.calls.map(([event]) => [event.step, event.outcome])).toEqual([
      ['direct', 'challenge'], ['trawl', 'ok'],
    ]);
    expect(recorder.step).toHaveBeenLastCalledWith(expect.objectContaining({
      fallbackFrom: 'direct', fallbackReason: 'challenge', fallbackErrorType: 'UpstreamHttpError',
      fallbackError: expect.objectContaining({ status: 403, kind: 'challenge' }),
    }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([json, document(json), document(`{"code":1,"message":"非法请求"}${json}`), `<html><body><pre>${escape(json)}</pre></body></html>`])(
    'reads JSON text without changing its history', async html => {
      const { trawl } = browser(html);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked));
      await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER))
        .resolves.toEqual(parseJsExpress(JSON.parse(json), NUMBER));
    });

  it('decodes an escaped ampersand in rendered JSON exactly once', async () => {
    const payload = JSON.parse(json) as { data: { tracking: { status: string }[] }[] };
    payload.data[0]!.tracking[0]!.status = 'Sample & courier update';
    const { trawl } = browser(document(JSON.stringify(payload)));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
    const result = await new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER);
    expect(result).toEqual(parseJsExpress(payload, NUMBER));
    expect(result.events![0]!.description).toBe('Sample & courier update');
  });

  it('preserves the exact unknown response after browser recovery', async () => {
    const { trawl } = browser(document(missing));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
    await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.each([URL.replace(NUMBER, OTHER), URL.replace('www.js-exp.com', 'other.invalid'), `${URL}&card_num=${OTHER}`])(
    'rejects a changed browser address', async url => {
      const { trawl } = browser(document(json), url);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
      await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    });

  it.each([
    document(json.replaceAll(NUMBER, OTHER)),
    `<html><body><input value="${NUMBER}"><pre>${escape(json)}</pre></body></html>`,
    `<html><body>Verification required<pre>${escape(json)}</pre></body></html>`,
    `<html><body><pre><span>${escape(json)}</span></pre></body></html>`,
    '<html><body>{"code": &quot;broken&quot;}</body></html>',
  ])('rejects another shipment or an ambiguous rendered reply', async html => {
    const { trawl } = browser(html);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
    await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a second challenge distinct from an unknown parcel', async () => {
    const { trawl, scrape } = browser(blocked);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(blocked, 403));
    await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(scrape).toHaveBeenCalledTimes(1);
  });

  it.each([[missing, 200], ['{}', 200], ['', 200], [missing, 429], [missing, 404], [missing, 500]])(
    'does not open a browser for a definite answer, rate limit or unrelated failure', async (body, status) => {
      const { trawl, scrape } = browser();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, status));
      await expect(new JsExpressTracker({ fetcher, trawl }).fetch(NUMBER)).rejects.toBeDefined();
      expect(scrape).not.toHaveBeenCalled();
    });

  it('leaves a successful HTTP read and HTTP recognition free of browser work', async () => {
    const { trawl, scrape } = browser();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(json));
    const direct = adapter({ fetcher, trawl, env: {}, recorder: NOOP_RECORDER, browserExecutablePath: null });
    await expect(direct.track({ number: NUMBER })).resolves.toMatchObject({ status: 'delivered' });
    await expect(direct.recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    fetcher.mockImplementation(async () => response(blocked, 403));
    await expect(direct.recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    expect(scrape).not.toHaveBeenCalled();
  });

  it('honours cancellation and a spent browser budget without starting recovery', async () => {
    const { trawl, scrape } = browser();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(blocked, 403));
    const tracker = new JsExpressTracker({ fetcher, trawl });
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
    expect(scrape).not.toHaveBeenCalled();
  });
});
