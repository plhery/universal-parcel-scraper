import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, isChallenge, normalizeZsda56Number, parseZsda56, PROVIDER, ZSDA56_MAX_BYTES } from './parser.js';

export { normalizeZsda56Number, parseZsda56 } from './parser.js';

/** The page the home page's tracking form posts to. */
export const ZSDA56_LOOKUP = 'https://www.zsda56.com/postdh.php';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The form for one parcel number abroad: `prid=2` picks the form's tab for parcels sent abroad. */
export function zsda56Form(number: string): string {
  return new URLSearchParams({ keyword: number, prid: '2', act: 'searchs' }).toString();
}

export class Zsda56Tracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The number alone; the page needs no account, and the session cookie it sets is not needed.
    const { response, bytes } = await fetchBounded(ZSDA56_LOOKUP, {
      method: 'POST', signal, body: zsda56Form(number), headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.zsda56.com', Referer: 'https://www.zsda56.com/', 'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: ZSDA56_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    }
    return parseZsda56(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeZsda56Number(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new Zsda56Tracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeZsda56Number(number))),
  };
};
