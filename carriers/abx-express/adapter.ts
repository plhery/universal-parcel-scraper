import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  ABX_ORIGIN, ABX_PAGE_MAX_BYTES, ABX_RESULT_MAX_BYTES, ABX_SEARCH, ABX_TRACK, CARRIER, isAbxChallenge, normalizeAbxNumber, parseAbx,
  parseAbxForm, PROVIDER,
} from './parser.js';

export { ABX_SEARCH, ABX_TRACK, normalizeAbxNumber, parseAbx } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;
// The anti-forgery cookie the form's token is bound to, and the load balancer's, which the page sets beside it.
const ANTIFORGERY_COOKIE = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}$/;
const BALANCER_COOKIE = /^acw_tc$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

/** The cookies the tracking page sets that its form needs back: the anti-forgery cookie, and the balancer's when set. */
function sessionCookies(response: Response): string {
  const pairs = response.headers.getSetCookie().map((header) => {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    return { name: pair.slice(0, separator), value: pair.slice(separator + 1), separator };
  }).filter(({ value, separator }) => separator > 0 && COOKIE_VALUE.test(value));
  const antiforgery = pairs.find(({ name }) => ANTIFORGERY_COOKIE.test(name));
  if (!antiforgery) throw new IndeterminateError(PROVIDER, 'ABX Express did not open an anonymous session');
  const balancer = pairs.find(({ name }) => BALANCER_COOKIE.test(name));
  return [balancer, antiforgery].filter((pair) => pair !== undefined).map(({ name, value }) => `${name}=${value}`).join('; ');
}

/** A refusal the site's firewall gives instead of a page. */
function refused(status: number, body: string): never {
  throw new ChallengeError(PROVIDER, isAbxChallenge(body) ? 'ABX Express answered with a browser check' : 'ABX Express refused the lookup', { status });
}

export class AbxTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeAbxNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the first gets
    // half of the budget, so the retry fits in the rest. An HTTP status is never sent again.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the tracking page makes it: the page opens a session and gives the form's token,
   * and the form posts the number. The page's slider check runs in the browser alone and fills the
   * form's `Captcha` field with `doneverify`, which the form sends as it is.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' };
    const options = { provider: PROVIDER, redirect: 'manual' as const, fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 400, 403] };

    const search = await fetchBounded(ABX_SEARCH, { method: 'GET', signal, headers },
      { ...options, maxBytes: ABX_PAGE_MAX_BYTES, timeoutMs: left() });
    if (search.response.status === 403) refused(403, decodeText(search.bytes));
    if (search.response.status !== 200) throw new TransportError(PROVIDER, 'ABX Express tracking page is unavailable', { status: search.response.status });
    const token = parseAbxForm(decodeText(search.bytes));
    const cookie = sessionCookies(search.response);
    signal.throwIfAborted();

    const lookup = await fetchBounded(ABX_TRACK, { method: 'POST', signal, headers: { ...headers, Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded', Origin: ABX_ORIGIN, Referer: ABX_SEARCH },
    body: new URLSearchParams({ ConsignmentNo: number, Captcha: 'doneverify', __RequestVerificationToken: token }).toString() },
    { ...options, maxBytes: ABX_RESULT_MAX_BYTES, timeoutMs: left() });
    // The site answers a token it does not take with HTTP 400, which says nothing about the number.
    if (lookup.response.status === 400) throw new IndeterminateError(PROVIDER, 'ABX Express refused the tracking form', { status: 400 });
    if (lookup.response.status === 403) refused(403, decodeText(lookup.bytes));
    if (lookup.response.status !== 200) throw new TransportError(PROVIDER, 'ABX Express tracking is unavailable', { status: lookup.response.status });
    return parseAbx(decodeText(lookup.bytes), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AbxTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The no-record row is the tracker's answer for a number it does not hold: recognition reads it as unknown.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAbxNumber(number))),
  };
};
