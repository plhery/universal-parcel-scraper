import type { Page, Request, Response as BrowserResponse } from 'playwright-core';
import { carrierErrorKind, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withLocalBrowser } from '../../core/transport/localBrowser.js';
import { isRecord } from '../../core/types.js';
import { parseRoyalMailTrackingResponse, royalMailEventsApiUrl, royalMailSummaryApiUrl, royalMailTrackingUrl } from './parser.js';

const PROVIDER = 'Royal Mail';
const ORIGIN = 'https://www.royalmail.com';
const MAX_BYTES = 2_000_000;

/** Observe the application's request; its issued session stays in the browser. */
export async function captureRoyalMailReply(page: Page, url: string, number: string, phase: 'summary' | 'events',
  signal: AbortSignal, timeoutMs: number, trigger: () => Promise<void>): Promise<Record<string, unknown>> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)))]);
  deadline.throwIfAborted();
  let active = true;
  let refresh = false;
  let bytes = 0;
  let count = 0;
  let resolve!: (piece: Record<string, unknown>) => void;
  let reject!: (error: unknown) => void;
  const reply = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  void reply.catch(() => {});
  const matches = (request: Request) => active && request.url() === url && request.method() === 'GET'
    && ['xhr', 'fetch'].includes(request.resourceType()) && request.frame() === page.mainFrame();
  const failed = (request: Request) => { if (matches(request)) reject(new TransportError(PROVIDER, 'Royal Mail tracking request failed')); };
  const aborted = () => reject(signal.aborted ? signal.reason : new TransportError(PROVIDER, 'Royal Mail tracking response timed out'));
  const received = (response: BrowserResponse) => {
    if (!matches(response.request())) return;
    void (async () => {
      if (++count > 3) throw new SchemaError(PROVIDER, 'Royal Mail returned too many tracking replies');
      const status = response.status();
      const headers = response.headers();
      if (status === 429) {
        const retry = headers['retry-after'];
        throw new RateLimitedError(PROVIDER, retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : undefined);
      }
      if (status === 403) throw new ChallengeError(PROVIDER);
      if (status === 410) throw new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable');
      if (![200, 401, 404].includes(status)) throw new UpstreamHttpError(PROVIDER, status);
      const invalid = () => status === 401 ? new ChallengeError(PROVIDER)
        : status === 404 ? new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable') : new SchemaError(PROVIDER);
      const length = headers['content-length'] === undefined ? 0 : Number(headers['content-length']);
      if (!(headers['content-type'] ?? '').includes('application/json') || !Number.isSafeInteger(length)
        || length < 0 || length > MAX_BYTES) throw invalid();
      // The page already buffers its XHR. Bound both the declared and decoded
      // capture, plus repeated replies, before parsing anything for the result.
      const body = await response.body();
      if (!active) return;
      bytes += body.byteLength;
      if (body.byteLength > MAX_BYTES || bytes > 2 * MAX_BYTES) throw new SchemaError(PROVIDER);
      let data: unknown;
      try { data = JSON.parse(body.toString('utf8')) as unknown; } catch { throw invalid(); }
      if (!isRecord(data)) throw new SchemaError(PROVIDER);
      const errors = Array.isArray(data.errors) ? data.errors.filter(isRecord) : [];
      const denied = errors.some(error => error.errorCode === 'E0015' || error.code === 'E0015');
      if (status === 401 && denied && !refresh) { refresh = true; return; }
      if (status === 401 || denied) throw new ChallengeError(PROVIDER);
      if (errors.some(error => error.errorCode === 'E1142' || error.code === 'E1142')) {
        throw new IndeterminateError(PROVIDER, 'Royal Mail could not confirm the tracking status');
      }
      if (status === 404) throw new TransportError(PROVIDER, 'Royal Mail tracking endpoint is unavailable');
      if (status !== 200) throw new UpstreamHttpError(PROVIDER, status);
      if (data.errors !== undefined || data.error !== undefined || data.httpCode !== undefined) throw new IndeterminateError(PROVIDER);
      const piece = data.mailPieces;
      if (!isRecord(piece) || piece.mailPieceId !== number
        || (phase === 'summary' ? !isRecord(piece.summary) : !Array.isArray(piece.events) || piece.events.length > 500)) {
        throw new SchemaError(PROVIDER, 'Royal Mail did not return the requested parcel history');
      }
      // Drop proof, recipient and credential fields before merging the replies.
      resolve(phase === 'summary' ? { mailPieceId: number, summary: piece.summary, estimatedDelivery: piece.estimatedDelivery }
        : { mailPieceId: number, events: piece.events,
          ...(isRecord(piece.estimatedDelivery) ? { estimatedDelivery: { date: piece.estimatedDelivery.date } } : {}) });
    })().catch(error => { if (active) reject(carrierErrorKind(error) ? error : new TransportError(PROVIDER)); });
  };
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

export function fetchRoyalMailInBrowser(number: string, executablePath: string, signal: AbortSignal,
  timeoutMs: number, fullHistory: boolean): Promise<CarrierResult> {
  return withLocalBrowser({ provider: PROVIDER, executablePath, signal, timeoutMs,
    args: ['--disable-blink-features=AutomationControlled'] }, async ({ browser, signal: session, remainingMs }) => {
    try {
      const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
      const major = browser.version().split('.')[0];
      const context = await browser.newContext({ locale: 'en-GB', acceptDownloads: false, serviceWorkers: 'block',
        userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` });
      session.throwIfAborted();
      const page = await context.newPage();
      const timeout = () => Math.min(15_000, remainingMs());
      const decline = async () => {
        const button = page.getByText('Decline all', { exact: true });
        await button.waitFor({ state: 'visible', timeout: Math.min(3_000, remainingMs()) }).catch(() => {});
        session.throwIfAborted();
        if (await button.isVisible()) {
          // Consent may reload the document and clear a number already typed.
          const reload = page.waitForEvent('domcontentloaded', { timeout: Math.min(4_000, remainingMs()) }).catch(() => {});
          await button.click({ timeout: timeout() });
          await reload;
          session.throwIfAborted();
        }
      };
      // Ordinary navigation lets the public site initialize its anonymous edge
      // session before the tracking application starts.
      const response = await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: timeout() });
      session.throwIfAborted();
      if (!response) throw new TransportError(PROVIDER);
      if ([401, 403].includes(response.status())) throw new ChallengeError(PROVIDER);
      if ([404, 410].includes(response.status())) throw new TransportError(PROVIDER, 'Royal Mail tracking page is unavailable');
      if (response.status() !== 200) throw new UpstreamHttpError(PROVIDER, response.status());
      if (new URL(page.url()).origin !== ORIGIN) throw new SchemaError(PROVIDER);
      await decline();
      const link = page.locator('a').filter({ hasText: /^\s*Track your item\s*$/i }).first();
      await link.waitFor({ state: 'visible', timeout: timeout() });
      const href = await link.getAttribute('href');
      const target = new URL(href ?? '', ORIGIN);
      if (target.origin !== ORIGIN || target.pathname !== '/track-your-item') throw new SchemaError(PROVIDER);
      // The site's fixed navigation can cover this link. Follow its validated
      // public destination with the same browser context instead of waiting on an overlay.
      const trackingPage = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeout() });
      session.throwIfAborted();
      if (!trackingPage) throw new TransportError(PROVIDER);
      if ([401, 403].includes(trackingPage.status())) throw new ChallengeError(PROVIDER);
      if ([404, 410].includes(trackingPage.status())) throw new TransportError(PROVIDER, 'Royal Mail tracking page is unavailable');
      if (trackingPage.status() !== 200) throw new UpstreamHttpError(PROVIDER, trackingPage.status());
      const input = page.locator('#barcode-input');
      await input.waitFor({ state: 'visible', timeout: timeout() });
      await decline();
      await input.waitFor({ state: 'visible', timeout: timeout() });
      const landed = new URL(page.url());
      if (landed.origin !== ORIGIN || landed.pathname !== '/track-your-item') throw new SchemaError(PROVIDER);
      await input.click({ timeout: timeout() });
      await input.pressSequentially(number, { delay: 80, timeout: timeout() });
      session.throwIfAborted();
      const summary = await captureRoyalMailReply(page, royalMailSummaryApiUrl(number), number, 'summary', session,
        Math.min(25_000, remainingMs()), async () => {
          if (await input.inputValue() !== number) throw new TransportError(PROVIDER, 'Royal Mail tracking form was reset');
          await page.locator('#submit:not(:disabled)').click({ timeout: timeout() });
        });
      // The summary issues an API session. The application's details handler
      // uses it, or performs its own CAPTCHA refresh when the session expires.
      parseRoyalMailTrackingResponse({ mailPieces: summary }, number);
      const history = fullHistory ? await captureRoyalMailReply(page, royalMailEventsApiUrl(number), number, 'events', session,
        Math.min(25_000, remainingMs()), () => page.locator('#btn-more-details').click({ timeout: timeout() })) : undefined;
      session.throwIfAborted();
      return { ...parseRoyalMailTrackingResponse({ mailPieces: { ...summary, ...(history ?? {}) } }, number),
        tracking_url: royalMailTrackingUrl(number), tracking_source: 'structured-web-response' };
    } catch (error) {
      session.throwIfAborted();
      if (carrierErrorKind(error)) throw error;
      // Native browser diagnostics can contain request URLs or page contents.
      throw new TransportError(PROVIDER, 'Royal Mail browser tracking failed');
    }
  });
}
