import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { MAERSK_MAX_BYTES, maerskLookupUrl, maerskPageUrl, maerskResult, notHeld, PROVIDER, type MaerskQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The page asks in seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;

const ORIGIN = new URL(maerskPageUrl({ kind: 'document', number: 'X' })).origin;

async function bodyOf(response: BrowserResponse): Promise<string> {
  const length = Number(response.headers()['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAERSK_MAX_BYTES) throw new SchemaError(PROVIDER, 'Maersk returned excessive tracking data');
  const bytes = await response.body();
  if (bytes.byteLength > MAERSK_MAX_BYTES) throw new SchemaError(PROVIDER, 'Maersk returned excessive tracking data');
  return bytes.toString('utf8');
}

/**
 * The reply to the page's own lookup for this number, read as JSON, or the error its status
 * stands for. Akamai refuses a lookup without the page's sensor data with a 403 of its own.
 */
async function readLookup(response: BrowserResponse, query: MaerskQuery): Promise<unknown> {
  const status = response.status();
  if (status === 403) throw new ChallengeError(PROVIDER, 'Akamai refused Maersk\'s tracking lookup');
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200 && status !== 404) throw new TransportError(PROVIDER, 'Maersk\'s tracking lookup is unavailable', { status });
  const body = await bodyOf(response);
  if (status === 404) throw notHeld(body, query) ?? new TransportError(PROVIDER, 'Maersk\'s tracking lookup is unavailable', { status });
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'Maersk returned tracking data that is not JSON', { cause });
  }
}

/**
 * Observes the page's calls while `trigger` opens it for one number, and reads the main frame's
 * GET of the lookup URL for this whole number and Maersk's carrier code.
 */
export async function captureMaerskReply(page: Page, query: MaerskQuery, signal: AbortSignal, timeoutMs: number,
  trigger: () => Promise<void>): Promise<unknown> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  const url = maerskLookupUrl(query);
  let active = true;
  let answered = false;
  let resolve!: (reply: unknown) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const fail = (error: unknown) => { if (active) reject(error); };
  const isLookup = (request: Request) => request.url() === url && request.method() === 'GET' && request.frame() === page.mainFrame();
  const received = (response: BrowserResponse) => {
    if (!active || answered || !isLookup(response.request())) return;
    answered = true;
    void readLookup(response, query).then(value => { if (active) resolve(value); })
      .catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'Maersk\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    if (isLookup(request)) fail(new TransportError(PROVIDER, 'Maersk\'s tracking request failed'));
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'Maersk\'s page sent no lookup in time'));
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
 * Opens Maersk's tracking page for the number in a fresh context and reads the reply to the
 * lookup the page makes itself, which carries the sensor data Akamai asks of it.
 */
export function fetchMaerskInBrowser(query: MaerskQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
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
      let reply: unknown;
      try {
        reply = await captureMaerskReply(page, query, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
          const response = await page.goto(maerskPageUrl(query), { waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
          session.throwIfAborted();
          if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER, 'Maersk redirected away from its tracking page');
          challenged = response?.status() === 403;
        });
      } catch (error) {
        if (challenged && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'Akamai refused Maersk\'s tracking page');
        throw error;
      }
      session.throwIfAborted();
      return maerskResult(reply, query);
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'Maersk browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
