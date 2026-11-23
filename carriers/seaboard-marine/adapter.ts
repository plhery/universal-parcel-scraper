import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { PROVIDER, SEABOARD_MAX_BYTES, seaboardMoveOf, seaboardQuery, seaboardResult, seaboardSearchUrl, type SeaboardQuery } from './parser.js';

export { containerCheckDigit, seaboardMoveOf, seaboardQuery, seaboardResult, seaboardSearchUrl } from './parser.js';

const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;

export interface SeaboardTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class SeaboardTracker {
  constructor(private readonly options: SeaboardTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const query = seaboardQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Seaboard Marine budget must be positive');
    // A request that fails to reach the website, or hangs, is sent once more.
    return runSteps<CarrierResult>({ carrier: 'seaboard-marine', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(query, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(query, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /** The page the website's equipment search opens for the container. */
  private async read(query: SeaboardQuery, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    signal.throwIfAborted();
    if (timeoutMs <= 0) throw new BudgetExceededError(PROVIDER, timeoutMs);
    const { response, bytes } = await fetchBounded(seaboardSearchUrl(query), {
      method: 'GET', signal, headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: SEABOARD_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [301, 302, 303, 307, 308, 404, 410] });
    // A redirect or a missing page is a moved route, not a container Seaboard Marine does not track.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Seaboard Marine\'s tracking page did not answer', { status: response.status });
    return seaboardResult(seaboardMoveOf(decodeText(bytes), query));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SeaboardTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'seaboard-marine', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
