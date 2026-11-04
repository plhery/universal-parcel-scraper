import { recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { ETOMARS_MAX_BYTES, isEtomarsRegistration, normalizeEtomarsNumber, parseEtomars, PROVIDER } from './parser.js';

export function etomarsUrl(raw: string): string {
  return 'https://cbt.shipnergy.com/Track/Result?' + new URLSearchParams({ mode: '0', ids: normalizeEtomarsNumber(raw) }).toString();
}

export class EtomarsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeEtomarsNumber(raw), url = etomarsUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { signal, headers: {
        'User-Agent': userAgentOf(this.options.userAgent), Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9',
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: ETOMARS_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'SHIPNERGY refused public tracking');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'SHIPNERGY tracking is unavailable', { status: response.status });
      return parseEtomars(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'etomars', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new EtomarsTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'etomars', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => isEtomarsRegistration(number)),
  };
};
