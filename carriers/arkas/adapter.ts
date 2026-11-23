import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  ARKAS_MAX_BYTES, ARKAS_TRACKER, arkasDocumentation, arkasHistoryUrl, arkasJson, arkasMoves, arkasQuery, arkasResult, arkasSearchUrl, PROVIDER,
} from './parser.js';

export { arkasQuery, arkasResult, containerCheckDigit } from './parser.js';

const DEFAULT_BUDGET_MS = 60_000;
const DIRECT_LIMIT_MS = 30_000;
const REQUEST_LIMIT_MS = 15_000;

export interface ArkasTrackerOptions {
  fetcher?: typeof fetch;
  recorder?: StepRecorder;
  userAgent?: string;
}

export class ArkasTracker {
  constructor(private readonly options: ArkasTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = arkasQuery(raw);
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Arkas Line budget must be positive');
    // A request that fails to reach Arkas, or hangs, gets one more.
    return runSteps<CarrierResult>({ carrier: 'arkas', budgetMs, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(Math.min(2 * DIRECT_LIMIT_MS, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, Math.min(DIRECT_LIMIT_MS, remainingMs))),
    ]);
  }

  /** As the tracking page asks: the documentations of the container, then the moves of its latest one. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    const documentation = arkasDocumentation(await this.get(arkasSearchUrl(number), signal, deadline), number);
    return arkasResult(documentation === null ? null : arkasMoves(await this.get(arkasHistoryUrl(documentation), signal, deadline)));
  }

  /**
   * One call of the tracking service through the page's relay. Arkas answers a number it does not
   * hold in the reply itself, so a missing address is the service gone, not the container.
   */
  private async get(url: string, signal: AbortSignal, deadline: number): Promise<unknown> {
    const timeoutMs = Math.max(1, Math.min(REQUEST_LIMIT_MS, Math.floor(deadline - Date.now())));
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', culture: 'en-US', Referer: ARKAS_TRACKER, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: ARKAS_MAX_BYTES, fetcher: this.options.fetcher, allowHttpStatuses: [404, 410] });
    if (!response.ok) throw new TransportError(PROVIDER, 'Arkas Line\'s tracking service is unavailable', { status: response.status });
    return arkasJson(decodeText(bytes));
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ArkasTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'arkas', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
