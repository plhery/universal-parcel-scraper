import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isJamaicaPostBlocked, JAMAICA_POST_FORM, JAMAICA_POST_MAX_BYTES, JAMAICA_POST_ORIGIN, JAMAICA_POST_RESULT, normalizeJamaicaPostNumber,
  parseJamaicaPostForm, parseJamaicaPostResult, PROVIDER,
} from './parser.js';

export { JAMAICA_POST_FORM, JAMAICA_POST_RESULT } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const SESSION_COOKIE = /^PHPSESSID=([A-Za-z0-9,-]{1,128})(?:;|$)/;
const DEFAULT_BUDGET_MS = 20_000;

/** The session cookie the form page sets, which its token belongs to. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const match = SESSION_COOKIE.exec(header);
    if (match) return `PHPSESSID=${match[1]}`;
  }
  throw new IndeterminateError(PROVIDER, 'Jamaica Post did not open an anonymous session');
}

/** A refusal the site or a firewall gives instead of a page. */
function refused(status: number, body: string): never {
  throw new ChallengeError(PROVIDER, isJamaicaPostBlocked(body) ? 'Jamaica Post answered with a block page' : 'Jamaica Post refused the lookup',
    { status });
}

export class JamaicaPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeJamaicaPostNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP status is never sent again.
    return runSteps({ carrier: 'jamaica-post', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the tracker's form makes it: the form page opens a session
   * and gives the form's token, and the form posts the number with it to the
   * result page.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const headers = { 'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html,application/xhtml+xml' };
    const options = { provider: PROVIDER, maxBytes: JAMAICA_POST_MAX_BYTES, redirect: 'manual' as const, fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410] };

    const form = await fetchBounded(JAMAICA_POST_FORM, { signal, headers }, { ...options, timeoutMs: left() });
    if (form.response.status === 403) refused(403, decodeText(form.bytes));
    if (form.response.status !== 200) throw new TransportError(PROVIDER, 'Jamaica Post tracking form is unavailable', { status: form.response.status });
    const token = parseJamaicaPostForm(decodeText(form.bytes));
    const cookie = sessionCookie(form.response);
    signal.throwIfAborted();

    const result = await fetchBounded(JAMAICA_POST_RESULT, { method: 'POST', signal, headers: { ...headers, Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded', Origin: JAMAICA_POST_ORIGIN, Referer: JAMAICA_POST_FORM },
    body: new URLSearchParams({ csrf_token: token, Consignment: number, submit: 'Track Now' }).toString() }, { ...options, timeoutMs: left() });
    if (result.response.status === 403) refused(403, decodeText(result.bytes));
    // A redirect, for an expired session or a token it no longer accepts, says nothing about the number.
    if (REDIRECTS.includes(result.response.status)) throw new IndeterminateError(PROVIDER, 'Jamaica Post sent the lookup back to its form');
    if (result.response.status !== 200) throw new TransportError(PROVIDER, 'Jamaica Post tracking is unavailable', { status: result.response.status });
    return parseJamaicaPostResult(decodeText(result.bytes), number);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JamaicaPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'jamaica-post', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeJamaicaPostNumber(number))),
  };
};
