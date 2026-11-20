import { randomInt } from 'node:crypto';
import type { CarrierResult } from '../../core/result/index.js';
import { BudgetExceededError, ChallengeError, TransportError } from '../../core/errors/index.js';
import { mtcaptchaToken, type MtcaptchaSite } from '../../core/transport/mtcaptcha.js';
import { decodeText, fetchBounded, parseJsonBytes, UpstreamHttpError, UpstreamNetworkError } from '../../core/transport/index.js';
import { parseHongkongPostHistory } from './history.js';
import { PROVIDER } from './parser.js';

// The official tracker's English page and its API host.
const PAGE = 'https://webapp.hongkongpost.hk/en/mail_tracking2/index.html';
export const HONGKONG_POST_TRACKING = 'https://webapp1.hongkongpost.hk/api1/v1/mailTracking/mail-tracking-message-mtCaptcha';
const SITE: MtcaptchaSite = { provider: PROVIDER, sitekey: 'MTPublic-l0oMcZgZB', domain: 'webapp.hongkongpost.hk', action: 'mailTracking' };
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface WebsiteLookup {
  fetcher?: typeof fetch;
  userAgent: string;
  signal: AbortSignal;
  /** When the step must end, on the `performance.now()` clock. */
  deadline: number;
  budgetMs: number;
  solve: (image: Uint8Array, signal: AbortSignal) => Promise<string>;
}

/** The tracker's own lookup: one MTCaptcha token for one request carrying the number. */
export async function trackOnWebsite(number: string, lookup: WebsiteLookup): Promise<CarrierResult> {
  const token = await mtcaptchaToken(SITE, lookup);
  const left = Math.floor(lookup.deadline - performance.now());
  if (left < 1) throw new BudgetExceededError(PROVIDER, lookup.budgetMs);
  // The page's `b` is a random string of eight letters and digits; `path` names its single-item form.
  const b = Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
  let bytes: Uint8Array;
  try {
    ({ bytes } = await fetchBounded(HONGKONG_POST_TRACKING, { method: 'POST', signal: lookup.signal, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/json; charset=UTF-8',
      Origin: 'https://webapp.hongkongpost.hk', Referer: PAGE, 'User-Agent': lookup.userAgent,
    }, body: JSON.stringify({ b, itemNo: number, lang: 'E', path: '2', mtCaptchaToken: token }) },
    { provider: PROVIDER, timeoutMs: left, maxBytes: 200_000, fetcher: lookup.fetcher }));
  } catch (error) {
    // The request's diagnostics would carry the token.
    if (error instanceof UpstreamHttpError) {
      if (error.status === 404 || error.status === 410) throw new TransportError(PROVIDER, 'Hongkong Post tracking endpoint is unavailable', { status: error.status });
      throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
    }
    if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
    throw error;
  }
  if (/^\s*</.test(decodeText(bytes.subarray(0, 256)))) throw new ChallengeError(PROVIDER, 'Hongkong Post answered with a web page instead of its tracking reply');
  return parseHongkongPostHistory(parseJsonBytes(bytes, PROVIDER), number);
}
