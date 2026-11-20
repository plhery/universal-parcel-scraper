import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { HMM_LOOKUP, HMM_MAX_BYTES, HMM_PAGE, hmmRequestBody, hmmResult, PROVIDER, type HmmQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The page searches in seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;

const ORIGIN = new URL(HMM_PAGE).origin;
// The search box for each kind of number; the page posts what is typed in the first.
const FIELDS: Readonly<Record<HmmQuery['kind'], string>> = { bl: 'srchBlNo1', cntr: 'srchCntrNo1' };

async function bodyOf(response: BrowserResponse): Promise<string> {
  const length = Number(response.headers()['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > HMM_MAX_BYTES) throw new SchemaError(PROVIDER, 'HMM returned excessive tracking data');
  const bytes = await response.body();
  if (bytes.byteLength > HMM_MAX_BYTES) throw new SchemaError(PROVIDER, 'HMM returned excessive tracking data');
  return bytes.toString('utf8');
}

/** The results of the page's search for this number, or the error their status stands for. */
async function readLookup(response: BrowserResponse, query: HmmQuery): Promise<CarrierResult> {
  const status = response.status();
  if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Akamai refused HMM\'s tracking lookup');
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200) throw new TransportError(PROVIDER, 'HMM\'s tracking lookup is unavailable', { status });
  return hmmResult(await bodyOf(response), query);
}

/** Whether a request posts exactly this number as the page's search does. */
function asksFor(request: Request, query: HmmQuery): boolean {
  let body: unknown;
  try { body = JSON.parse(request.postData() ?? ''); } catch { return false; }
  return JSON.stringify(body) === hmmRequestBody(query);
}

/**
 * Observes the page's calls while `trigger` searches it for one number, and reads the main
 * frame's POST of the lookup for this whole number alone.
 */
export async function captureHmmReply(page: Page, query: HmmQuery, signal: AbortSignal, timeoutMs: number,
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
  const isLookup = (request: Request) => request.url() === HMM_LOOKUP && request.method() === 'POST'
    && request.frame() === page.mainFrame() && asksFor(request, query);
  const received = (response: BrowserResponse) => {
    if (!active || answered || !isLookup(response.request())) return;
    answered = true;
    void readLookup(response, query).then(value => { if (active) resolve(value); })
      .catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'HMM\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    if (isLookup(request)) fail(new TransportError(PROVIDER, 'HMM\'s tracking request failed'));
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'HMM\'s page sent no lookup in time'));
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
 * Opens HMM's tracking page in a fresh context, types the number into its search and reads the
 * results the search posts for, which Akamai lets through where it refuses plain HTTP.
 */
export function fetchHmmInBrowser(query: HmmQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
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
        return await captureHmmReply(page, query, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
          const response = await page.goto(HMM_PAGE, { waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          session.throwIfAborted();
          challenged = response?.status() === 403;
          if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER, 'HMM redirected away from its tracking page');
          await page.waitForFunction(() => typeof (window as unknown as { search?: unknown }).search === 'function', null,
            { timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          await page.fill(`input[name=${FIELDS[query.kind]}]`, query.number, { timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          await page.evaluate(() => (window as unknown as { search: () => void }).search());
        });
      } catch (error) {
        if (challenged && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'Akamai refused HMM\'s tracking page');
        throw error;
      }
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'HMM browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
