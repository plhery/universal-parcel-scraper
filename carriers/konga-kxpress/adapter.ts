import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KONGA_MAX_BYTES, normalizeKongaNumber, parseKonga, PROVIDER } from './parser.js';

export { kongaClock, normalizeKongaNumber, parseKonga } from './parser.js';

// The tracker answers a number it does not know with HTTP 200: a redirect or a missing route is a moved tracker.
const MOVED = [301, 302, 303, 307, 308, 404, 410];
const DEFAULT_BUDGET_MS = 20_000;

/** The tracker's page for one number. */
export const kongaTrackingUrl = (number: string): string =>
  `https://logistics.konga.com/track?order_number=${encodeURIComponent(number)}`;

export class KongaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(kongaTrackingUrl(number), { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: KONGA_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: MOVED });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'logistics.konga.com moved its tracking page', { status: response.status });
    return parseKonga(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKongaNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KongaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
