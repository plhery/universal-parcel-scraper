import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { APD_MAX_BYTES, APD_TRACKER, normalizeApdNumber, parseApdPage, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// The tracker answers every label with HTTP 200; a missing route is not a missing parcel.
const GONE = [404, 410];

/** The form the tracking page's script posts for its search key. */
export function apdForm(number: string): URLSearchParams {
  return new URLSearchParams({ fn: 'goto', page: 'tracking/brief', label: normalizeApdNumber(number) });
}

export class ApdTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeApdNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(APD_TRACKER, { method: 'POST', signal, headers: {
        Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent),
      }, body: apdForm(number).toString() }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: APD_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] })
        .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'APD redirected its tracker', { status: response.status });
      if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'APD\'s tracker is unavailable', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'APD refused the lookup', { status: 403 });
      return parseApdPage(decodeText(bytes), number);
    };
    // A lookup that fails to reach APD, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: 'apd-parcel', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ApdTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'apd-parcel', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
