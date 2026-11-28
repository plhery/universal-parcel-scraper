import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isChallenge, normalizeUbuyNumber, parseUbuy, PROVIDER, UBUY_MAX_BYTES } from './parser.js';

export { normalizeUbuyNumber, parseUbuy, ubuyText } from './parser.js';

/** The tracking page, which takes the number from its address. */
export const UBUY_PAGE = 'https://www.ubuylogi.com/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracking page's address for one number. */
export function ubuyUrl(number: string): string {
  return `${UBUY_PAGE}?${new URLSearchParams({ num: number })}`;
}

export class UbuyTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone, with no session or account.
    const { response, bytes } = await fetchBounded(ubuyUrl(number), {
      method: 'GET', signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: UBUY_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    }
    return parseUbuy(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeUbuyNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new UbuyTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeUbuyNumber(number))),
  };
};
