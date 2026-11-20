import type { BrowserContext, Frame, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { PROVIDER, ZIM_LOOKUP, ZIM_MAX_BYTES, ZIM_PAGE, zimPageUrl, zimReplyText, type ZimQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** Akamai's check takes seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 40_000;

const ORIGIN = new URL(ZIM_PAGE).origin;
// Akamai's check in place of the page: a frame with a box to tick and a button the box enables,
// after which the check reloads the page. It weighs how the pointer reaches them, so the pointer
// moves to each before it presses.
const CHECK_FRAME = 'iframe#sec-cpt-if';
const CHECK_BOX = '#robot-checkbox';
const CHECK_PROCEED = '.behavioral-button:not(.progress-btn-disabled) #progress-button';

async function bodyOf(response: BrowserResponse): Promise<string> {
  const length = Number(response.headers()['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > ZIM_MAX_BYTES) throw new SchemaError(PROVIDER, 'ZIM returned excessive tracking data');
  const bytes = await response.body();
  if (bytes.byteLength > ZIM_MAX_BYTES) throw new SchemaError(PROVIDER, 'ZIM returned excessive tracking data');
  return bytes.toString('utf8');
}

/** The reply to the page's lookup for this number, or the error its status stands for. */
async function readLookup(response: BrowserResponse, query: ZimQuery): Promise<CarrierResult> {
  const status = response.status();
  if (status === 401 || status === 403) throw new ChallengeError(PROVIDER, 'Akamai refused ZIM\'s tracking lookup');
  if (status === 429) throw new RateLimitedError(PROVIDER);
  if (status >= 500) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200) throw new TransportError(PROVIDER, 'ZIM\'s tracking lookup is unavailable', { status });
  return zimReplyText(await bodyOf(response), query);
}

/** Whether a request is the lookup for exactly this number. */
function asksFor(request: Request, query: ZimQuery): boolean {
  let url: URL;
  try { url = new URL(request.url()); } catch { return false; }
  return `${url.origin}${url.pathname}` === ZIM_LOOKUP && url.searchParams.getAll('reference').length === 1
    && url.searchParams.get('reference') === query.number;
}

/**
 * Observes the page's calls while `trigger` loads it for one number, and reads the main frame's
 * GET of the lookup for this whole number alone.
 */
export async function captureZimReply(page: Page, query: ZimQuery, signal: AbortSignal, timeoutMs: number,
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
  const isLookup = (request: Request) => request.method() === 'GET' && request.frame() === page.mainFrame() && asksFor(request, query);
  const received = (response: BrowserResponse) => {
    if (!active || answered || !isLookup(response.request())) return;
    answered = true;
    void readLookup(response, query).then(value => { if (active) resolve(value); })
      .catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'ZIM\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    if (isLookup(request)) fail(new TransportError(PROVIDER, 'ZIM\'s tracking request failed'));
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'ZIM\'s page sent no lookup in time'));
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

/** Moves the pointer onto an element of Akamai's check, as a hand would, and presses it. */
async function press(page: Page, frame: Frame, selector: string, timeoutMs: number): Promise<void> {
  const target = await frame.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
  const box = await target.boundingBox();
  if (!box) throw new ChallengeError(PROVIDER, 'Akamai\'s check on ZIM\'s page hid its box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 100 - 40 * Math.random(), y + 70 + 40 * Math.random(), { steps: 4 });
  await page.mouse.move(x, y, { steps: 15 });
  await page.mouse.click(x, y, { delay: 80 });
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
 * Opens ZIM's tracking page for the number in a fresh context, passes Akamai's check when it
 * shows one by ticking its box, and reads the reply to the lookup the page then makes.
 */
export function fetchZimInBrowser(query: ZimQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
    const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`;
    const window = () => Math.max(1, remainingMs() - CLEANUP_MS);
    const step = () => Math.min(NAVIGATION_LIMIT_MS, window());
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block', userAgent });
      session.throwIfAborted();
      const page = await context.newPage();
      session.throwIfAborted();
      let challenged = false;
      try {
        return await captureZimReply(page, query, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
          const response = await page.goto(zimPageUrl(query), { waitUntil: 'domcontentloaded', timeout: step() });
          session.throwIfAborted();
          challenged = response?.status() === 403;
          if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER, 'ZIM redirected away from its tracking page');
          const check = await page.$(CHECK_FRAME);
          if (!check) return;
          challenged = true;
          const frame = await check.contentFrame();
          if (!frame) throw new ChallengeError(PROVIDER, 'Akamai\'s check on ZIM\'s page did not load');
          await press(page, frame, CHECK_BOX, step());
          await press(page, frame, CHECK_PROCEED, step());
        });
      } catch (error) {
        if (challenged && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'Akamai\'s check on ZIM\'s page did not clear');
        throw error;
      }
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Browser diagnostics can quote request URLs, headers or page content.
      throw new TransportError(PROVIDER, 'ZIM browser tracking failed');
    } finally {
      if (context) await close(context);
    }
  });
}
