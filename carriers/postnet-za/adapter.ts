import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isPostNetBlocked, normalizePostNetNumber, parsePostNetEvents, parsePostNetTracker, POSTNET_MAX_BYTES, POSTNET_NETWORKS, POSTNET_TRACKER,
  postNetLookupUrl, postNetResult, PROVIDER,
} from './parser.js';

export { POSTNET_LOOKUP, POSTNET_TRACKER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const SESSION_COOKIE = /^PHPSESSID=([A-Za-z0-9,-]{1,128})(?:;|$)/;
// The tracker's own message for a lookup without a live session.
const SESSION_EXPIRED = /tracking session has expired/i;
// Each network takes one to three seconds to answer.
const DEFAULT_BUDGET_MS = 30_000;

/** The session cookie the tracker page sets, which its token belongs to. */
function sessionCookie(response: Response): string {
  for (const header of response.headers.getSetCookie()) {
    const match = SESSION_COOKIE.exec(header);
    if (match) return `PHPSESSID=${match[1]}`;
  }
  throw new IndeterminateError(PROVIDER, 'PostNet did not open an anonymous session');
}

export class PostNetTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostNetNumber(raw);
    // An attempt that fails to reach the site, or hangs, gets one more in a new session: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP status is never sent again.
    return runSteps({ carrier: 'postnet-za', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.attempt(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.attempt(number, signal, remainingMs)),
    ]);
  }

  /**
   * One lookup as the tracker page makes it: the page opens a session and
   * gives a token, and the page asks each network PostNet sends parcels with
   * for the waybill. The first network with events answers; the waybill is
   * missing only when every network answers without it.
   */
  private async attempt(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = performance.now() + timeoutMs;
    // A request left without time fails as a timeout, which the retry can recover.
    const left = () => Math.max(1, Math.floor(deadline - performance.now()));
    const userAgent = userAgentOf(this.options.userAgent);
    const options = { provider: PROVIDER, maxBytes: POSTNET_MAX_BYTES, redirect: 'manual' as const, fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 403, 404, 410] };

    const page = await fetchBounded(POSTNET_TRACKER, { signal, headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' } },
      { ...options, timeoutMs: left() });
    if (page.response.status === 403) throw new ChallengeError(PROVIDER, 'PostNet refused the tracker page', { status: 403 });
    if (page.response.status !== 200) throw new TransportError(PROVIDER, 'PostNet tracker page is unavailable', { status: page.response.status });
    const token = parsePostNetTracker(decodeText(page.bytes));
    const headers = { 'User-Agent': userAgent, Accept: 'application/json, text/javascript, */*; q=0.01', Cookie: sessionCookie(page.response),
      'X-Requested-With': 'XMLHttpRequest', Referer: POSTNET_TRACKER };

    for (const network of POSTNET_NETWORKS) {
      signal.throwIfAborted();
      const reply = await fetchBounded(postNetLookupUrl(number, network, token), { signal, headers }, { ...options, timeoutMs: left() });
      const body = decodeText(reply.bytes);
      if (reply.response.status === 403) {
        // The session or its token was refused, which says nothing about the waybill.
        if (SESSION_EXPIRED.test(body) || !isPostNetBlocked(body)) throw new IndeterminateError(PROVIDER, 'PostNet refused the tracking session');
        throw new ChallengeError(PROVIDER, 'PostNet answered with a block page', { status: 403 });
      }
      if (REDIRECTS.includes(reply.response.status)) throw new IndeterminateError(PROVIDER, 'PostNet sent the lookup elsewhere');
      if (reply.response.status !== 200) throw new TransportError(PROVIDER, 'PostNet tracking is unavailable', { status: reply.response.status });
      const events = parsePostNetEvents(body, network);
      if (events.length) return postNetResult(events);
    }
    throw new NotFoundError(PROVIDER);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostNetTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'postnet-za', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizePostNetNumber(number))),
  };
};
