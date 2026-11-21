import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { DAYTONA_MAX_BYTES, daytonaUrl, normalizeDaytonaNumber, parseDaytona, PROVIDER } from './parser.js';

export { DAYTONA_TRACKER, normalizeDaytonaNumber, parseDaytona } from './parser.js';

export class DaytonaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(protocol: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    signal.throwIfAborted();
    const { response, bytes } = await fetchBounded(daytonaUrl(protocol), { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: DAYTONA_MAX_BYTES, redirect: 'manual',
      allowHttpStatuses: [301, 302, 303, 307, 308, 403, 429], fetcher: this.options.fetcher });
    if (response.status === 429) throw new RateLimitedError(PROVIDER);
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Daytona Express refused the tracking page', { status: 403 });
    // A redirect is a moved or closed tracker, not a missing shipment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Daytona Express tracking moved', { status: response.status });
    return parseDaytona(decodeText(bytes), protocol);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const protocol = normalizeDaytonaNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(protocol, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(protocol, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DaytonaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
