import type { Page, Response as BrowserResponse } from 'playwright-core';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { carrierErrorKind, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { normalizeLbcNumber, parseLbc } from './parser.js';
import { readLbcMobile } from './mobile.js';

const ORIGIN = 'https://www.lbcexpress.com';
const MAX_BYTES = 1_000_000;
export const LBC_SEARCH = `${ORIGIN}/AMisc/searchRedirect`;

export function lbcRedirectUrl(payload: unknown): string {
  // This is the opaque handle returned by the current official form, not an
  // encoding of the input. Restrict it to one same-origin path component.
  if (!isRecord(payload) || payload.page_slug !== 'track' || typeof payload.hash !== 'string'
    || !/^[A-Za-z0-9=+_-]{8,256}$/.test(payload.hash)) {
    throw new SchemaError('lbc-express', 'LBC returned an invalid tracking redirect');
  }
  return `${ORIGIN}/track/${payload.hash}`;
}

function httpFailure(status: number): Error {
  if ([401, 403].includes(status)) return new ChallengeError('lbc-express');
  return [404, 410].includes(status)
    ? new TransportError('lbc-express', 'LBC tracking endpoint is unavailable', { status })
    : new UpstreamHttpError('lbc-express', status);
}

async function openReady(page: Page, url: string, selector: string, signal: AbortSignal, remainingMs: () => number): Promise<void> {
  signal.throwIfAborted();
  const expected = new URL(url);
  const timeout = Math.min(15_000, remainingMs());
  const ready = page.waitForResponse((response: BrowserResponse) => {
    const target = new URL(response.url());
    return response.request().isNavigationRequest() && response.request().frame() === page.mainFrame()
      && target.origin === ORIGIN && target.pathname === expected.pathname && response.status() === 200;
  }, { timeout });
  void ready.catch(() => {});
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  signal.throwIfAborted();
  if (!response) throw new TransportError('lbc-express', 'LBC tracking page is unavailable');
  if (![200, 403].includes(response.status())) throw httpFailure(response.status());
  try {
    // Azure WAF can initially return 403, execute its own JavaScript, and
    // reload the same document successfully. Wait for that native completion.
    if (response.status() === 403) await ready;
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: Math.min(15_000, remainingMs()) });
  } catch {
    signal.throwIfAborted();
    if (response.status() === 403) throw new ChallengeError('lbc-express');
    throw new TransportError('lbc-express', 'LBC tracking page did not become ready');
  }
  signal.throwIfAborted();
  const settled = new URL(page.url());
  if (settled.origin !== ORIGIN || settled.pathname !== expected.pathname) throw new SchemaError('lbc-express', 'LBC redirected away from the requested tracking page');
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number) {
  return withLocalBrowser({ provider: 'lbc-express', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    try {
      const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
      const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block', userAgent });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      await openReady(page, `${ORIGIN}/`, 'body', session, remainingMs);
      await openReady(page, `${ORIGIN}/track/`, '#inputTrackingSearchForm', session, remainingMs);
      // Mirror the current delegated jQuery form handler. Submitting in the
      // page keeps the anonymous browser session without requiring hydration.
      const reply = await page.evaluate(async ({ number, timeout, maxBytes, endpoint }) => {
        const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeout),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json, text/javascript, */*; q=0.01' }, body: new URLSearchParams({ keyword: number }).toString() });
        if (Number(response.headers.get('content-length')) > maxBytes) return { status: response.status, oversized: true, body: '' };
        const reader = response.body?.getReader();
        if (!reader) return { status: response.status, oversized: false, body: '' };
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) { await reader.cancel(); return { status: response.status, oversized: true, body: '' }; }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let position = 0;
        for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
        return { status: response.status, oversized: false, body: new TextDecoder().decode(bytes) };
      }, { number, timeout: Math.min(15_000, remainingMs()), maxBytes: MAX_BYTES, endpoint: LBC_SEARCH });
      session.throwIfAborted();
      if (reply.status !== 200) throw httpFailure(reply.status);
      if (reply.oversized) throw new SchemaError('lbc-express', 'LBC returned excessive redirect data');
      let redirect: unknown;
      try { redirect = JSON.parse(reply.body); }
      catch { throw new SchemaError('lbc-express', 'LBC returned invalid redirect JSON'); }
      const url = lbcRedirectUrl(redirect);
      await openReady(page, url, '#inputTrackingSearchForm', session, remainingMs);
      const html = await page.content();
      session.throwIfAborted();
      return parseLbc(html, number);
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Playwright errors can contain the opaque capability URL. Do not retain
      // those messages or causes in errors exposed to callers or telemetry.
      throw new TransportError('lbc-express', 'LBC browser tracking failed');
    }
  });
}

export class LbcExpressTracker {
  constructor(private readonly options: { executablePath?: string | null; recorder?: StepRecorder;
    key?: string | null; fetcher?: typeof fetch; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeLbcNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('LBC budget must be between 1 and 60000 ms');
    if (this.options.key === null && !this.options.executablePath) throw new ChallengeError('lbc-express', 'LBC requires a tracking API key or a configured browser');
    return runSteps({ carrier: 'lbc-express', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', enabled: this.options.key !== null, run: ({ signal, remainingMs }) => readLbcMobile(number, {
        key: this.options.key, fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal,
        timeoutMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs))),
      }) },
      { id: 'browser', enabled: Boolean(this.options.executablePath), run: ({ signal, remainingMs }) => localBrowser(number, this.options.executablePath!, signal, Math.max(1, Math.floor(remainingMs))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const key = environment.env.LBC_TRACKING_KEY;
  const tracker = new LbcExpressTracker({ executablePath: environment.browserExecutablePath, recorder: environment.recorder,
    key: key === undefined ? undefined : key.trim() || null, fetcher: environment.fetcher, userAgent: environment.userAgent });
  return { id: 'lbc-express', recordsSteps: true, steps: ['direct', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
