import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, NotFoundError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { COSCO_CONTAINERS, COSCO_DETAIL, COSCO_EXISTS, COSCO_MAX_BYTES, COSCO_ORIGIN, coscoBillResult, coscoContainerResult,
  coscoNumberType, coscoPageUrl, decodeCoscoReply, PROVIDER, type CoscoQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The page answers in seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;

type Call = 'exists' | 'lookup';

/**
 * Which of the page's calls for this number a request is, if any. A call for
 * any other number means the page changed, and fails the lookup.
 */
function coscoCall(request: Request, page: Page, query: CoscoQuery): Call | null {
  const lookup = query.kind === 'container' ? COSCO_CONTAINERS : COSCO_DETAIL;
  const call = request.url() === COSCO_EXISTS ? 'exists' : request.url() === lookup ? 'lookup' : null;
  if (!call || request.method() !== 'POST' || request.frame() !== page.mainFrame()) return null;
  let body: unknown;
  try { body = request.postDataJSON(); } catch { body = undefined; }
  if (!isRecord(body) || body.businessNumber !== query.number || body.businessNumberType !== coscoNumberType(query)) {
    throw new SchemaError(PROVIDER, 'The cargo tracking page asked for a different number');
  }
  return call;
}

function callFailure(status: number): Error | null {
  if (status === 200) return null;
  if (status === 429) return new RateLimitedError(PROVIDER);
  if ([401, 403].includes(status)) return new ChallengeError(PROVIDER, 'COSCO\'s bot manager blocked the page');
  if ([404, 410].includes(status)) return new TransportError(PROVIDER, 'COSCO\'s cargo tracking lookup is unavailable', { status });
  return new UpstreamHttpError(PROVIDER, status);
}

/** Whether the page's first call found nothing for the number, which it then does not look up. */
function holdsNothing(body: string): boolean {
  const found = decodeCoscoReply(body).result;
  if (!isRecord(found)) throw new SchemaError(PROVIDER, 'COSCO returned an invalid shipment check');
  return found.bookingNumber === '' && ['shipmentSize', 'fullChainSize', 'truckSize', 'warehouseSize', 'customsSize'].every(key => !found[key]);
}

/**
 * Observes the page's calls for one number while `trigger` loads the page:
 * its check for the shipment, then its lookup. The page passes COSCO's bot
 * manager for itself. A check that finds nothing is the answer, since the page
 * then looks nothing up; otherwise the lookup's reply is.
 */
export async function captureCoscoReply(page: Page, query: CoscoQuery, signal: AbortSignal, timeoutMs: number,
  trigger: () => Promise<void>): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let answered = false;
  let resolve!: (body: string) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const fail = (error: unknown) => { if (active) reject(error); };
  const received = (response: BrowserResponse) => {
    if (!active || answered) return;
    void (async () => {
      const call = coscoCall(response.request(), page, query);
      if (!call) return;
      const failure = callFailure(response.status());
      if (failure) throw failure;
      const length = Number(response.headers()['content-length'] ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > COSCO_MAX_BYTES) throw new SchemaError(PROVIDER, 'COSCO returned excessive tracking data');
      const bytes = await response.body();
      if (bytes.byteLength > COSCO_MAX_BYTES) throw new SchemaError(PROVIDER, 'COSCO returned excessive tracking data');
      const body = bytes.toString('utf8');
      if (call === 'exists') {
        if (!holdsNothing(body)) return;
        throw new NotFoundError(PROVIDER, query.kind === 'container' ? 'COSCO does not hold this container' : 'COSCO does not hold this bill of lading or booking');
      }
      answered = true;
      if (active) resolve(body);
    })().catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'COSCO\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    try {
      if (coscoCall(request, page, query)) fail(new TransportError(PROVIDER, 'COSCO\'s tracking request failed'));
    } catch (error) { fail(error); }
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'COSCO\'s cargo tracking page sent no lookup in time'));
  page.on('response', received);
  page.on('requestfailed', failed);
  deadline.addEventListener('abort', aborted, { once: true });
  try {
    deadline.throwIfAborted();
    await Promise.race([trigger(), reply.then(() => {})]);
    return await reply;
  } finally {
    active = false;
    page.off('response', received);
    page.off('requestfailed', failed);
    deadline.removeEventListener('abort', aborted);
  }
}

/** Closes a context without letting a hung close outlast the time kept for it. */
async function close(context: BrowserContext): Promise<void> {
  const limit = AbortSignal.timeout(CLEANUP_MS);
  let done!: () => void;
  const expired = new Promise<void>(resolve => { done = resolve; });
  limit.addEventListener('abort', () => done(), { once: true });
  await Promise.race([context.close().catch(() => {}), expired]);
}

/**
 * Opens the public cargo tracking page for the number in a fresh context and
 * reads the reply the page requests for itself.
 */
export function fetchCoscoInBrowser(query: CoscoQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    let context: BrowserContext | undefined;
    try {
      const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
      const major = browser.version().split('.')[0];
      context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block',
        userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      const window = () => Math.max(1, remainingMs() - CLEANUP_MS);
      let blocked = false;
      let body: string;
      try {
        body = await captureCoscoReply(page, query, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
          const response = await page.goto(coscoPageUrl(query), { waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          session.throwIfAborted();
          if (new URL(page.url()).origin !== COSCO_ORIGIN) throw new SchemaError(PROVIDER, 'COSCO redirected away from its cargo tracking page');
          // The bot manager's own check can answer first and reload the page once it passes.
          blocked = response?.status() === 403;
        });
      } catch (error) {
        if (blocked && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'COSCO\'s bot manager blocked the page');
        throw error;
      }
      session.throwIfAborted();
      return query.kind === 'container' ? coscoContainerResult(body, query.number) : coscoBillResult(body, query.number);
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'COSCO browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
