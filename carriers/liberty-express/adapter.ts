import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isLibertyChallenge, isLibertyMessagePage, LIBERTY_MAX_BYTES, LIBERTY_ORIGIN, LIBERTY_SEARCH, libertyTrackingUrl, normalizeLibertyNumber,
  parseLiberty, parseLibertyForm, parseLibertySearch, PROVIDER,
} from './parser.js';

export { LIBERTY_SEARCH, LIBERTY_TRACKING } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const ANTIFORGERY_COOKIE = /^\.AspNetCore\.Antiforgery\.[A-Za-z0-9_-]{1,40}$/;
const COOKIE_VALUE = /^[^\s;,]{1,1024}$/;

/** The anti-forgery cookie the search page sets, which its form's token is bound to. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (separator > 0 && ANTIFORGERY_COOKIE.test(name) && COOKIE_VALUE.test(value)) return `${name}=${value}`;
  }
  throw new IndeterminateError(PROVIDER, 'Liberty Express did not open an anonymous session');
}

/** A refusal the CDN or the site gives instead of a page. */
function refused(status: number, body: string): never {
  throw new ChallengeError(PROVIDER, isLibertyChallenge(body) ? 'Liberty Express answered with a browser check' : 'Liberty Express refused the lookup',
    { status });
}

export class LibertyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLibertyNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP status is never sent again.
    return runSteps({ carrier: 'liberty-express', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the search page makes it: the page opens a session and gives
   * the form's token, the form posts the number, and the site redirects a
   * number it finds to its warehouse receipt's tracking page.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es' };
    const options = { provider: PROVIDER, maxBytes: LIBERTY_MAX_BYTES, redirect: 'manual' as const, fetcher: this.options.fetcher };

    const search = await fetchBounded(LIBERTY_SEARCH, { signal, headers },
      { ...options, timeoutMs: left(), allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (search.response.status === 403) refused(403, decodeText(search.bytes));
    if (search.response.status !== 200) throw new TransportError(PROVIDER, 'Liberty Express search page is unavailable');
    const token = parseLibertyForm(decodeText(search.bytes));
    const cookie = sessionCookie(search.response);
    signal.throwIfAborted();

    const lookup = await fetchBounded(LIBERTY_SEARCH, { method: 'POST', signal, headers: { ...headers, Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded', Origin: LIBERTY_ORIGIN, Referer: LIBERTY_SEARCH },
    body: new URLSearchParams({ hreflang: '', FromMobileApp: 'False', FromReactApp: 'False', NGuia: number,
      __RequestVerificationToken: token }).toString() }, { ...options, timeoutMs: left(), allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
    // The site answers a token it does not accept with an empty HTTP 400, which says nothing about the number.
    if (lookup.response.status === 400) throw new IndeterminateError(PROVIDER, 'Liberty Express refused the tracking form');
    if (lookup.response.status === 403) refused(403, decodeText(lookup.bytes));
    // A number it does not find comes back on the search page with a notice.
    if (lookup.response.status === 200) parseLibertySearch(decodeText(lookup.bytes), number);
    if (!REDIRECTS.includes(lookup.response.status)) throw new TransportError(PROVIDER, 'Liberty Express tracking is unavailable');
    const url = libertyTrackingUrl(lookup.response.headers.get('location'), number);
    signal.throwIfAborted();

    const tracking = await fetchBounded(url, { signal, headers: { ...headers, Cookie: cookie, Referer: LIBERTY_SEARCH } },
      { ...options, timeoutMs: left(), allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    if (REDIRECTS.includes(tracking.response.status)) {
      if (isLibertyMessagePage(tracking.response.headers.get('location'))) {
        throw new IndeterminateError(PROVIDER, 'Liberty Express sent the tracking page to its message page');
      }
      throw new TransportError(PROVIDER, 'Liberty Express moved its tracking page');
    }
    if (tracking.response.status === 403) refused(403, decodeText(tracking.bytes));
    if (tracking.response.status !== 200) throw new TransportError(PROVIDER, 'Liberty Express tracking page is unavailable');
    return parseLiberty(decodeText(tracking.bytes), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new LibertyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'liberty-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLibertyNumber(number))),
  };
};
