import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizePolarExpressNumber, parsePolarExpress, POLAR_EXPRESS_MAX_BYTES, PROVIDER } from './parser.js';

export { normalizePolarExpressNumber, parsePolarExpress } from './parser.js';

/** Polar Express's tracker, which its site sends customers to; the page for a number is rendered on the server. */
export const POLAR_EXPRESS_TRACKER = 'https://the-tracking.com/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

/** The tracker's page for a number. */
export const polarExpressTrackerUrl = (number: string): string => `${POLAR_EXPRESS_TRACKER}${encodeURIComponent(number)}/`;

export class PolarExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(polarExpressTrackerUrl(number), { signal, headers: {
      Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs, maxBytes: POLAR_EXPRESS_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved tracker, not a missing parcel.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'the-tracking.com moved its tracking page', { status: response.status });
    return parsePolarExpress(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePolarExpressNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PolarExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
