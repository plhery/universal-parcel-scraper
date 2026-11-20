import type { BrowserContext, Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { decryptOoclReply, notHeld, OOCL_CAPTCHA_CONFIG, OOCL_LINK_PATH, OOCL_MAX_BYTES, OOCL_ORIGIN, OOCL_SUMMARY, OOCL_TRACKER_ORIGIN,
  OOCL_TRACKER_PAGE, ooclLinkUrl, ooclLookups, ooclResult, PROVIDER, type OoclLookup, type OoclQuery } from './parser.js';

/** Kept back from the lookup's budget so the browser context closes inside it. */
export const CLEANUP_MS = 1_500;
/** The tracker answers in seconds; a page that never loads or never asks must not hold the shared browser. */
export const NAVIGATION_LIMIT_MS = 15_000;
export const CAPTURE_LIMIT_MS = 25_000;
const TICKET = /^[0-9a-f]{32}$/;

/** Whether a request is the site's link for this number and lookup. */
function isLink(request: Request, number: string, lookup: OoclLookup): boolean {
  const url = new URL(request.url());
  return url.origin === OOCL_ORIGIN && url.pathname === OOCL_LINK_PATH && url.searchParams.get('eltype') === 'ct'
    && url.searchParams.get('businessType') === lookup && url.searchParams.get('businessNumber') === number;
}

/** The ticket the site's link handed this number to the tracker with, if the request is that hand-over. */
function handedTicket(request: Request, page: Page, number: string, lookup: OoclLookup): string | null {
  if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return null;
  const url = new URL(request.url());
  if (`${url.origin}${url.pathname}` !== OOCL_TRACKER_PAGE) return null;
  let link = request.redirectedFrom();
  while (link && !isLink(link, number, lookup)) link = link.redirectedFrom();
  const ticket = url.searchParams.get('ticket') ?? '';
  return link && TICKET.test(ticket) ? ticket : null;
}

function callFailure(status: number): Error | null {
  if (status === 200) return null;
  if (status === 429) return new RateLimitedError(PROVIDER);
  if ([401, 403].includes(status)) return new ChallengeError(PROVIDER, 'Cloudflare blocked OOCL\'s tracker');
  if ([404, 410].includes(status)) return new TransportError(PROVIDER, 'OOCL\'s cargo tracking lookup is unavailable', { status });
  return new UpstreamHttpError(PROVIDER, status);
}

async function bodyOf(response: BrowserResponse): Promise<string> {
  const length = Number(response.headers()['content-length'] ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > OOCL_MAX_BYTES) throw new SchemaError(PROVIDER, 'OOCL returned excessive tracking data');
  const bytes = await response.body();
  if (bytes.byteLength > OOCL_MAX_BYTES) throw new SchemaError(PROVIDER, 'OOCL returned excessive tracking data');
  return bytes.toString('utf8');
}

/**
 * Observes the tracker's calls while `trigger` follows the site's link for one number:
 * the link hands the number to the tracker as a ticket in the page's address, the page
 * asks whether to show a CAPTCHA, then asks for the ticket's shipments. Only the
 * shipments asked for with the ticket handed over for this number are the answer.
 */
export async function captureOoclReply(page: Page, number: string, lookup: OoclLookup, signal: AbortSignal, timeoutMs: number,
  trigger: () => Promise<void>): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let answered = false;
  let ticket: string | null = null;
  let resolve!: (body: string) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const fail = (error: unknown) => { if (active) reject(error); };
  const isCall = (request: Request, url: string) => request.url() === url && request.method() === 'POST' && request.frame() === page.mainFrame();
  const requested = (request: Request) => {
    const handed = handedTicket(request, page, number, lookup);
    if (!handed) return;
    if (ticket && ticket !== handed) fail(new SchemaError(PROVIDER, 'OOCL handed the number over twice'));
    ticket = handed;
  };
  const received = (response: BrowserResponse) => {
    if (!active || answered) return;
    const request = response.request();
    const summary = isCall(request, OOCL_SUMMARY);
    if (!summary && !isCall(request, OOCL_CAPTCHA_CONFIG)) return;
    void (async () => {
      if (summary && (!ticket || await request.headerValue('x-ct-ticket') !== ticket)) return;
      const failure = callFailure(response.status());
      if (failure) throw failure;
      const body = await bodyOf(response);
      if (!summary) {
        // The page shows its CAPTCHA before it asks for anything when the tracker says so.
        if ((await decryptOoclReply(body)).result === true) throw new ChallengeError(PROVIDER, 'OOCL\'s tracker asks for a CAPTCHA');
        return;
      }
      answered = true;
      if (active) resolve(body);
    })().catch(error => fail(carrierErrorKind(error) ? error : new TransportError(PROVIDER, 'OOCL\'s tracking reply could not be read')));
  };
  const failed = (request: Request) => {
    if (isCall(request, OOCL_SUMMARY)) fail(new TransportError(PROVIDER, 'OOCL\'s tracking request failed'));
  };
  const aborted = () => fail(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'OOCL\'s tracker sent no lookup in time'));
  page.on('request', requested);
  page.on('response', received);
  page.on('requestfailed', failed);
  deadline.addEventListener('abort', aborted, { once: true });
  try {
    deadline.throwIfAborted();
    await Promise.race([trigger(), reply.then(() => {})]);
    return await reply;
  } finally {
    active = false;
    page.off('request', requested);
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
 * Follows the site's link for the number into the public tracker, in a fresh context for
 * each lookup the number takes, and reads the shipments the page asks for itself.
 */
export function fetchOoclInBrowser(query: OoclQuery, executablePath: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
    const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version().split('.')[0]}.0.0.0 Safari/537.36`;
    const window = () => Math.max(1, remainingMs() - CLEANUP_MS);
    for (const lookup of ooclLookups(query)) {
      let context: BrowserContext | undefined;
      try {
        // A fresh context: the page keeps its last lookup in session storage.
        context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block', userAgent });
        session.throwIfAborted();
        const page = await context.newPage();
        session.throwIfAborted();
        let challenged = false;
        let body: string;
        try {
          body = await captureOoclReply(page, query.number, lookup, session, Math.min(CAPTURE_LIMIT_MS, window()), async () => {
            const response = await page.goto(ooclLinkUrl(query.number, lookup), { waitUntil: 'domcontentloaded', timeout: Math.min(NAVIGATION_LIMIT_MS, window()) });
            session.throwIfAborted();
            if (![OOCL_ORIGIN, OOCL_TRACKER_ORIGIN].includes(new URL(page.url()).origin)) throw new SchemaError(PROVIDER, 'OOCL redirected away from its tracker');
            // Cloudflare's own check can answer first and reload the page once it passes.
            challenged = response?.status() === 403 || response?.headers()['cf-mitigated'] === 'challenge';
          });
        } catch (error) {
          if (challenged && carrierErrorKind(error) === 'transport' && !session.aborted) throw new ChallengeError(PROVIDER, 'Cloudflare stopped OOCL\'s tracker');
          throw error;
        }
        session.throwIfAborted();
        const result = ooclResult(await decryptOoclReply(body), query, lookup);
        if (result) return result;
      } catch (error) {
        session.throwIfAborted();
        if (carrierErrorKind(error)) throw error;
        // Browser diagnostics can quote request URLs, headers or page content.
        throw new TransportError(PROVIDER, 'OOCL browser tracking failed');
      } finally {
        if (context) await close(context);
      }
    }
    throw notHeld(query);
  });
}
