import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { MSC_LOOKUP, MSC_MAX_BYTES, mscMode, mscPageUrl, mscReplyText, PROVIDER, type MscQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The page searches in seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;

const ORIGIN = new URL(MSC_LOOKUP).origin;

async function bodyOf(response: BrowserResponse): Promise<string> {
  const length = Number(response.headers()['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > MSC_MAX_BYTES) throw new SchemaError(PROVIDER, 'MSC returned excessive tracking data');
  const bytes = await response.body();
  if (bytes.byteLength > MSC_MAX_BYTES) throw new SchemaError(PROVIDER, 'MSC returned excessive tracking data');
  return bytes.toString('utf8');
}

/** The reply to the page's lookup for this number, or the error its status stands for. */
async function readLookup(response: BrowserResponse, query: MscQuery): Promise<CarrierResult> {
  const status = response.status();
  if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Akamai refused MSC\'s tracking lookup');
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200) throw new TransportError(PROVIDER, 'MSC\'s tracking lookup is unavailable', { status });
  return mscReplyText(await bodyOf(response), query);
}

/** Whether a request posts exactly this number and its mode, as the page's search does. */
function asksFor(request: Request, query: MscQuery): boolean {
  let body: unknown;
  try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  return typeof body === 'object' && body !== null && Object.keys(body).length === 2
    && (body as Record<string, unknown>).trackingNumber === query.number && (body as Record<string, unknown>).trackingMode === mscMode(query);
}

/**
 * Observes the page's calls while `trigger` opens it for one number, and reads the main frame's
 * POST of the lookup for this whole number and its mode.
 */
export async function captureMscReply(page: Page, query: MscQuery, signal: AbortSignal, timeoutMs: number,
  trigger: () => Promise<void>): Promise<CarrierResult> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let answered = false;
  let resolve!: (reply: CarrierResult) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<CarrierResult>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const fail = (error: unknown) => { if (active) reject(error); };
  const isLookup = (request: Request) => request.url() === MSC_LOOKUP && request.method() === 'POST'
    && request.frame() === page.mainFrame() && asksFor(request, query);
  const received = (response: BrowserResponse) => {
    if (!active || answered || !isLookup(response.request())) return;
    answered = true;
    void readLookup(response, query).then(value => { if (active) resolve(value); })
      .catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'MSC\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    if (isLookup(request)) fail(new TransportError(PROVIDER, 'MSC\'s tracking request failed'));
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'MSC\'s page sent no lookup in time'));
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
 * Opens MSC's tracking page on its link for the number in a fresh context and reads the reply to
 * the search the page makes itself, which Akamai lets through where it refuses plain HTTP.
 */
export function fetchMscInBrowser(query: MscQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
    const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`;
    const window = () => Math.max(1, remainingMs() - CLEANUP_MS);
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block', userAgent });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      let challenged = false;
      try {
        return await captureMscReply(page, query, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
          const response = await page.goto(mscPageUrl(query), { waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          session.throwIfAborted();
          if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER, 'MSC redirected away from its tracking page');
          challenged = response?.status() === 403;
        });
      } catch (error) {
        if (challenged && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'Akamai refused MSC\'s tracking page');
        throw error;
      }
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'MSC browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
