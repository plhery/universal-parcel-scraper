import type { BrowserContext } from 'playwright-core';
import { carrierErrorKind, TransportError } from '../../core/errors/index.js';
import { serviceTag } from '../../core/runner/holds.js';
import { withRemoteBrowser } from '../../core/transport/localBrowser.js';

/**
 * USPS through a private Chrome that has a window.
 *
 * USPS's verification accepts Google Chrome with a window on a residential connection and
 * leaves headless Chrome, Chromium and Firefox builds on its blank wrapper. A new context's
 * first navigation gets the wrapper, whose script earns the session; a second navigation
 * two seconds later loads tracking. The session's cookies carry over to a later context of
 * the same browser, which then loads tracking at its first navigation, so the accepted
 * cookies are kept in memory between lookups. They only work from the address that earned them.
 */
export const USPS_OUTAGE_URL = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';
/** The time the wrapper's script takes to earn a session before the page is asked again. */
const NEW_SESSION_WAIT_MS = 2_000;
/** A kept session loads tracking within two seconds; one USPS no longer accepts gets the wrapper, and is asked again. */
const KEPT_SESSION_WAIT_MS = 3_000;
/** A page asked again loads tracking within two seconds. */
const TRACKING_WAIT_MS = 6_000;
const MAX_NAVIGATIONS = 3;
/** Left to close the context and bring the answer back. */
const CLOSING_MS = 1_500;
/** The page's pictures, fonts and video are a third of its bytes and no part of the answer. */
const SKIPPED = new Set(['image', 'font', 'media']);
/** Akamai's own requests, pixels included, are part of the verification. */
const VERIFICATION_PATH = /^\/akam\//;

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const sessions = new Map<string, Cookies>();

export interface UspsBrowserRead {
  endpoint: string;
  url: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Replaced in tests. */
  withBrowser?: typeof withRemoteBrowser;
}

export interface UspsBrowserPage {
  html: string;
  /** USPS sent the navigation to its outage page. */
  redirected: boolean;
}

function skipped(type: string, url: string): boolean {
  if (!SKIPPED.has(type)) return false;
  try { return !VERIFICATION_PATH.test(new URL(url).pathname); } catch { return false; }
}

export async function readUspsPage(read: UspsBrowserRead): Promise<UspsBrowserPage> {
  const key = serviceTag(read.endpoint);
  const withBrowser = read.withBrowser ?? withRemoteBrowser;
  try {
    return await withBrowser({ provider: 'USPS', endpoint: read.endpoint, timeoutMs: read.timeoutMs, signal: read.signal },
      async ({ browser, remainingMs }) => {
        // The window's own size: an emulated viewport is one more difference from an ordinary Chrome.
        const context = await browser.newContext({ viewport: null });
        try {
          await context.route('**/*', route => (skipped(route.request().resourceType(), route.request().url())
            ? route.abort('blockedbyclient') : route.fallback()));
          const kept = sessions.get(key);
          if (kept) await context.addCookies(kept);
          const page = await context.newPage();
          let waitMs = kept ? KEPT_SESSION_WAIT_MS : NEW_SESSION_WAIT_MS;
          for (let navigation = 1; ; navigation += 1) {
            await page.goto(read.url, { waitUntil: 'domcontentloaded', timeout: remainingMs() });
            const loaded = !page.url().startsWith(USPS_OUTAGE_URL) && await page.waitForSelector('#trackingNum',
              { state: 'attached', timeout: Math.max(1, Math.min(waitMs, remainingMs() - CLOSING_MS)) }).then(() => true, () => false);
            if (page.url().startsWith(USPS_OUTAGE_URL)) {
              sessions.delete(key);
              return { html: '', redirected: true };
            }
            if (loaded) {
              sessions.set(key, (await context.cookies()).filter(cookie => /(^|\.)usps\.com$/.test(cookie.domain)));
              return { html: await page.content(), redirected: false };
            }
            if (navigation === MAX_NAVIGATIONS || remainingMs() < 2 * CLOSING_MS) {
              // The parser names what the page is; a session that no longer loads tracking is not kept.
              sessions.delete(key);
              return { html: await page.content(), redirected: false };
            }
            waitMs = TRACKING_WAIT_MS;
          }
        } finally {
          await context.close().catch(() => { /* Disconnecting disposes it. */ });
        }
      });
  } catch (error) {
    if (read.signal?.aborted || carrierErrorKind(error)) throw error;
    // Playwright's messages can carry the page's address and the service's.
    throw new TransportError('USPS', 'USPS browser read failed');
  }
}

/** For tests: forgets every kept session. */
export function forgetUspsBrowserSessions(): void {
  sessions.clear();
}
