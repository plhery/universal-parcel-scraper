import { type AdapterFactory, recognizeFromLookup, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JETSPEED_MAX_BYTES, JETSPEED_NUMBER, jetspeedUrl, parseJetspeedPage, PROVIDER } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];

export class JetspeedTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = raw.replace(/\s+/g, '').toUpperCase();
    if (!JETSPEED_NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter one JETSPEED tracking number');
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(jetspeedUrl(number), { signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: JETSPEED_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403] })
        .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'JETSPEED redirected its tracker', { status: response.status });
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'JETSPEED refused the lookup', { status: 403 });
      return parseJetspeedPage(decodeText(bytes), number);
    };
    // A lookup that fails to reach the tracker, or hangs, gets one more try: the first gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new JetspeedTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    // The tracker's error page names an unknown number, so recognition asks the same lookup.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context)),
  };
};
