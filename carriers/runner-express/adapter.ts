import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CARRIER, isRunnerExpressBlocked, normalizeRunnerExpressNumber, parseRunnerExpress, PROVIDER, RUNNER_EXPRESS_MAX_BYTES,
} from './parser.js';

export { normalizeRunnerExpressNumber, parseRunnerExpress } from './parser.js';

/** The page the site's tracking form opens. */
export const RUNNER_EXPRESS_TRACK = 'https://runnerexpress.co.il/track/';
const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers every number with HTTP 200: a missing route is not a missing parcel.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one number, as the form on the site's home page builds it: its one field. */
export function runnerExpressLookupUrl(number: string): string {
  return `${RUNNER_EXPRESS_TRACK}?${new URLSearchParams({ search_query: number })}`;
}

export class RunnerExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(runnerExpressLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RUNNER_EXPRESS_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    const { status } = response;
    if (status === 403) {
      const body = decodeText(bytes);
      if (isRunnerExpressBlocked(body)) throw new ChallengeError(PROVIDER, 'Runner Express answered with a browser check', { status });
      throw new ChallengeError(PROVIDER, 'Runner Express refused the lookup', { status });
    }
    if (status !== 200) throw new TransportError(PROVIDER, 'Runner Express tracking is unavailable', { status });
    return parseRunnerExpress(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRunnerExpressNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Runner Express for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RunnerExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
