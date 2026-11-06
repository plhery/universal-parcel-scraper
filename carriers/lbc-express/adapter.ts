import type { Page, Request as BrowserRequest, Response as BrowserResponse } from 'playwright-core';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { normalizeLbcNumber, parseLbcWebsite } from './parser.js';
import { readLbcMobile } from './mobile.js';

const ORIGIN = 'https://www.lbcexpress.com';
const MAX_BYTES = 1_000_000;
export const LBC_TRACK_PAGE = `${ORIGIN}/track/`;
export const LBC_TRACK_REQUEST = `${ORIGIN}/wp-admin/admin-ajax.php`;

function httpFailure(status: number, retryAfter?: string): Error {
  if (status < 100) return new TransportError('lbc-express', 'The bound browser request failed');
  const retryMs = retryAfter === undefined ? NaN : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  if ([401, 403].includes(status)) return new ChallengeError('lbc-express');
  return [404, 410].includes(status)
    ? new TransportError('lbc-express', 'LBC tracking endpoint is unavailable', { status })
    : new UpstreamHttpError('lbc-express', status, Number.isFinite(retryMs) ? Math.max(0, retryMs) : undefined);
}

/** The service observes the page's whole-number POST and decodes only that response. */
async function trawlBrowser(number: string, trawl: TrawlClient, fetcher: typeof fetch | undefined, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
  const timeoutMs = Math.floor(Math.min(25_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
  if (timeoutMs < 1) throw new BudgetExceededError('lbc-express', remainingMs);
  const url = `${LBC_TRACK_PAGE}?${new URLSearchParams({ 'tracking-number': number })}`;
  const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
    captureResponses: [LBC_TRACK_REQUEST], settleTimeout: 1000 },
  { provider: 'TRAWL while fetching LBC Express', timeoutMs, signal, fetcher,
    maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
  signal.throwIfAborted();
  if (page.url !== url || (typeof page.raw.effectiveUrl === 'string' && page.raw.effectiveUrl !== url)) throw new SchemaError('lbc-express', 'LBC redirected away from its tracking page');
  let result: CarrierResult | undefined;
  let failure: Error | undefined;
  for (const entry of page.capturedResponses.filter(entry => entry.url === LBC_TRACK_REQUEST)) {
    if (!entry.trackingNumberSubmitted) throw new TransportError('lbc-express', 'The browser service does not support bound LBC capture');
    if (entry.trackingNumberSubmitted !== number) throw new SchemaError('lbc-express', 'The browser service did not bind the whole LBC request');
    result = undefined;
    if (entry.status !== 200) { failure = httpFailure(entry.status, entry.headers['retry-after']); continue; }
    if (entry.truncated || entry.error || entry.base64Encoded || typeof entry.body !== 'string'
      || new TextEncoder().encode(entry.body).byteLength > MAX_BYTES) throw new SchemaError('lbc-express', 'LBC returned unreadable tracking data');
    let payload: unknown;
    try { payload = JSON.parse(entry.body); }
    catch { throw new SchemaError('lbc-express', 'LBC returned invalid tracking JSON'); }
    try { result = parseLbcWebsite(payload, number); failure = undefined; }
    catch (error) {
      // A later automatic retry must never conceal a mismatched shipment.
      if (carrierErrorKind(error) === 'schema') throw error;
      failure = error instanceof Error ? error : new TransportError('lbc-express', 'LBC tracking could not be parsed');
    }
  }
  if (result) return result;
  if (failure) throw failure;
  if (page.statusCode !== 200) throw httpFailure(page.statusCode);
  throw new TransportError('lbc-express', 'LBC tracking page sent no bound tracking response');
}

/** The tracking page's own `track_package` request for the whole number. */
function isLbcTrackRequest(request: BrowserRequest, page: Page, number: string): boolean {
  if (request.method() !== 'POST' || request.url() !== LBC_TRACK_REQUEST || request.frame() !== page.mainFrame()) return false;
  const form = new URLSearchParams(request.postData() ?? '');
  return form.get('action') === 'track_package' && form.get('trackingNumber') === number;
}

function localBrowser(number: string, executablePath: string, signal: AbortSignal, timeoutMs: number) {
  return withLocalBrowser({ provider: 'lbc-express', executablePath, signal, timeoutMs }, async ({ browser, signal: session, remainingMs }) => {
    try {
      const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
      const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block', userAgent });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      // The page's script sends its tracking request for the number in its
      // link. Observe before navigating, so the reply cannot be missed.
      const answered = page.waitForResponse((response: BrowserResponse) => isLbcTrackRequest(response.request(), page, number),
        { timeout: Math.min(30_000, remainingMs()) });
      void answered.catch(() => {});
      const document = await page.goto(`${LBC_TRACK_PAGE}?${new URLSearchParams({ 'tracking-number': number })}`,
        { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remainingMs()) });
      session.throwIfAborted();
      if (!document) throw new TransportError('lbc-express', 'LBC tracking page is unavailable');
      if (![200, 403].includes(document.status())) throw httpFailure(document.status());
      let reply: BrowserResponse;
      try {
        // Azure WAF can initially return 403, execute its own JavaScript, and
        // reload the same document, whose script then sends the request.
        reply = await answered;
      } catch {
        session.throwIfAborted();
        if (document.status() === 403) throw new ChallengeError('lbc-express');
        throw new TransportError('lbc-express', 'LBC tracking page sent no tracking request');
      }
      session.throwIfAborted();
      const settled = new URL(page.url());
      if (settled.origin !== ORIGIN || settled.pathname !== new URL(LBC_TRACK_PAGE).pathname) {
        throw new SchemaError('lbc-express', 'LBC redirected away from the tracking page');
      }
      if (reply.status() !== 200) throw httpFailure(reply.status());
      if (Number(reply.headers()['content-length']) > MAX_BYTES) throw new SchemaError('lbc-express', 'LBC returned excessive tracking data');
      const bytes = await reply.body();
      session.throwIfAborted();
      if (bytes.byteLength > MAX_BYTES) throw new SchemaError('lbc-express', 'LBC returned excessive tracking data');
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new SchemaError('lbc-express', 'LBC returned invalid tracking JSON'); }
      return parseLbcWebsite(payload, number);
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Playwright errors can contain the requested number and the page's
      // request. Do not retain those messages or causes in errors exposed to
      // callers or telemetry.
      throw new TransportError('lbc-express', 'LBC browser tracking failed');
    }
  });
}

export class LbcExpressTracker {
  constructor(private readonly options: { executablePath?: string | null; recorder?: StepRecorder;
    fetcher?: typeof fetch; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  fetch(raw: string, context: TrackingContext = {}) {
    const number = normalizeLbcNumber(raw);
    const budgetMs = context.budgetMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('LBC budget must be between 1 and 60000 ms');
    return runSteps({ carrier: 'lbc-express', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => readLbcMobile(number, {
        fetcher: this.options.fetcher, userAgent: this.options.userAgent, signal,
        timeoutMs: Math.max(1, Math.min(10_000, Math.floor(remainingMs))),
      }) },
      { id: 'trawl', enabled: Boolean(this.options.trawl), run: ({ signal, remainingMs }) => trawlBrowser(number,
        this.options.trawl!, this.options.fetcher, signal, remainingMs) },
      { id: 'browser', enabled: Boolean(this.options.executablePath), run: ({ signal, remainingMs }) => localBrowser(number, this.options.executablePath!, signal, Math.max(1, Math.floor(remainingMs))) },
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LbcExpressTracker({ executablePath: environment.browserExecutablePath, recorder: environment.recorder,
    fetcher: environment.fetcher, userAgent: environment.userAgent, trawl: environment.trawl });
  return { id: 'lbc-express', recordsSteps: true, steps: ['direct', 'trawl', 'browser'], track: (input, context) => tracker.fetch(input.number, context) };
};
