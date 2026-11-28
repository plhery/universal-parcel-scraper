import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CARRIER, DYEXPRESS_MAX_BYTES, isChallenge, normalizeDyexpressNumber, parseDyexpress, PROVIDER } from './parser.js';

export { dyexpressText, normalizeDyexpressNumber, parseDyexpress, placeOf } from './parser.js';

/** The query page the site's tracking form posts to. */
export const DYEXPRESS_LOOKUP = 'https://www.dy-express.com/query/serchi';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class DyexpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The form's one field, with one number; it needs no cookie, token or account.
    const { response, bytes } = await fetchBounded(DYEXPRESS_LOOKUP, {
      method: 'POST', signal, body: new URLSearchParams({ keyword: number }).toString(), headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.dy-express.com', Referer: DYEXPRESS_LOOKUP, 'User-Agent': userAgentOf(this.options.userAgent),
      },
    }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: DYEXPRESS_MAX_BYTES,
      timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
    // An unknown number is HTTP 200 too; anything else is a moved route, a refusal or a browser check.
    if (response.status !== 200) {
      if (response.status === 403 && isChallenge(decodeText(bytes))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
      throw new TransportError(PROVIDER, `${PROVIDER} tracking lookup is unavailable`, { status: response.status });
    }
    return parseDyexpress(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeDyexpressNumber(raw);
    // A request that fails to reach the site, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DyexpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeDyexpressNumber(number))),
  };
};
