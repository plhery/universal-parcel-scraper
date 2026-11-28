import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  AAE_ORIGIN, AAE_PAGE, AAE_PAGE_MAX_BYTES, AAE_RESULT_MAX_BYTES, AAE_TRACK, CARRIER, isAaeChallenge, normalizeAaeNumber, parseAae,
  parseAaeToken, PROVIDER,
} from './parser.js';

export { AAE_PAGE, AAE_TRACK, normalizeAaeNumber, parseAae, parseAaeToken } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;
// The anti-forgery cookie the page's token is bound to.
const ANTIFORGERY_COOKIE = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

/** The anti-forgery cookie the tracking page sets, which its lookups send back. */
function sessionCookie(response: Response): string {
  const pair = response.headers.getSetCookie().map((header) => header.split(';', 1)[0] ?? '').map((value) => {
    const separator = value.indexOf('=');
    return { name: value.slice(0, Math.max(separator, 0)), value: value.slice(separator + 1) };
  }).find(({ name, value }) => ANTIFORGERY_COOKIE.test(name) && COOKIE_VALUE.test(value));
  if (!pair) throw new IndeterminateError(PROVIDER, 'AAE did not open an anonymous session');
  return `${pair.name}=${pair.value}`;
}

/** A page that is not the tracker's: a bot check, an outage or a changed site. */
function unexpected(status: number, body: string, what: string): never {
  if (isAaeChallenge(body)) throw new ChallengeError(PROVIDER, 'AAE answered with a verification page', { status });
  if (status !== 200) throw new TransportError(PROVIDER, `AAE ${what} is unavailable`, { status });
  throw new SchemaError(PROVIDER, `AAE answered with something other than its ${what}`);
}

export class AaeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeAaeNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the first gets half
    // of the budget, so the retry fits in the rest.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the tracking page makes it: the page opens a session and gives its token, and the page's
   * script posts the number to the handler with the token in a header. No account, captcha or browser.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' };
    const options = { provider: PROVIDER, redirect: 'manual' as const, fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 429, 500, 502, 503] };

    const page = await fetchBounded(AAE_PAGE, { method: 'GET', signal, headers: { ...headers, Accept: 'text/html,application/xhtml+xml' } },
      { ...options, maxBytes: AAE_PAGE_MAX_BYTES, timeoutMs: left() });
    const pageBody = decodeText(page.bytes);
    if (page.response.status !== 200 || !pageBody.includes('__RequestVerificationToken')) unexpected(page.response.status, pageBody, 'tracking page');
    const token = parseAaeToken(pageBody);
    const cookie = sessionCookie(page.response);
    signal.throwIfAborted();

    const lookup = await fetchBounded(`${AAE_TRACK}&${new URLSearchParams({ trackingNumber: number })}`, { method: 'POST', signal,
      headers: { ...headers, Accept: 'text/html, */*; q=0.01', Cookie: cookie, 'XSRF-TOKEN': token, 'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: AAE_ORIGIN, Referer: AAE_PAGE },
      body: '' }, { ...options, maxBytes: AAE_RESULT_MAX_BYTES, timeoutMs: left() });
    const body = decodeText(lookup.bytes);
    // The handler answers a token it does not take with HTTP 400, which says nothing about the number.
    if (lookup.response.status === 400) throw new IndeterminateError(PROVIDER, 'AAE refused the lookup\'s token', { status: 400 });
    if (lookup.response.status !== 200 || !body.includes('dcc-item')) unexpected(lookup.response.status, body, 'tracking reply');
    return parseAae(body, number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AaeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
