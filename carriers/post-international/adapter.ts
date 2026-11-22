import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CHALLENGE, normalizePostIntNumber, parsePostInt, POST_INT_ACTION, POST_INT_AJAX, POST_INT_HOME, POST_INT_MAX_BYTES, postIntPageNonce,
  PROVIDER } from './parser.js';

export { parsePostInt } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
// WordPress gives visitors without an account one nonce for at least twelve hours; it is read again after an hour.
const NONCE_KEPT_MS = 60 * 60_000;
// WordPress's answer to a nonce it refuses.
const REFUSED = Symbol('refused nonce');

export class PostIntTracker {
  #nonce: { value: string; readAt: number } | undefined;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePostIntNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const kept = this.#keptNonce();
      let reply = await this.#lookup(number, kept ?? await this.#pageNonce(signal, left()), signal, left());
      // A kept nonce may have expired: the page gives the current one.
      if (reply === REFUSED && kept) reply = await this.#lookup(number, await this.#pageNonce(signal, left()), signal, left());
      if (reply === REFUSED) throw new SchemaError(PROVIDER, 'Post-International refused its home page\'s nonce');
      return parsePostInt(reply, number);
    };
    // A request that fails to reach the site, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'post-international', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** The home page form's request for one number, with no session or account: the reply's body, or REFUSED. */
  async #lookup(number: string, nonce: string, signal: AbortSignal, timeoutMs: number): Promise<string | typeof REFUSED> {
    const body = new URLSearchParams({ trackingID: number, action: POST_INT_ACTION, nonce_code: nonce }).toString();
    const { response, bytes } = await fetchBounded(POST_INT_AJAX, { method: 'POST', signal, body, headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Origin: 'https://post-int.com', Referer: POST_INT_HOME, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: POST_INT_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410] });
    const text = decodeText(bytes);
    if (text.trim() === '-1' && [200, 400, 403].includes(response.status)) return REFUSED;
    if (response.status === 401 || response.status === 403) throw new ChallengeError(PROVIDER, 'Post-International refused the lookup', { status: response.status });
    // An unknown number is HTTP 200 too; anything else, such as WordPress's 0 for an action it lost, is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Post-International tracking lookup is unavailable', { status: response.status });
    return text;
  }

  #keptNonce(): string | undefined {
    const now = (this.options.now ?? Date.now)();
    return this.#nonce && now - this.#nonce.readAt < NONCE_KEPT_MS ? this.#nonce.value : undefined;
  }

  /** The nonce the home page gives now. */
  async #pageNonce(signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { response, bytes } = await fetchBounded(POST_INT_HOME, { method: 'GET', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: PAGE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
    if (response.status === 401 || response.status === 403) throw new ChallengeError(PROVIDER, 'Post-International refused its home page', { status: response.status });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Post-International\'s home page is unavailable', { status: response.status });
    const page = decodeText(bytes);
    const nonce = postIntPageNonce(page);
    if (nonce) {
      this.#nonce = { value: nonce, readAt: (this.options.now ?? Date.now)() };
      return nonce;
    }
    if (CHALLENGE.test(page.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Post-International answered its home page with a browser check');
    throw new SchemaError(PROVIDER, 'Post-International\'s home page no longer gives its tracking nonce');
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PostIntTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'post-international', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
