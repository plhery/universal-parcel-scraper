import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchAllegroTracking } from '../allegro-one/client.js';
import { normalizeWedoNumber, parseWedo, PROVIDER } from './parser.js';

export const WEDO_ENDPOINT = 'https://edge.onedelivery.cz/one/tracking';
const CHALLENGE = /cf[-_]chl[-_]|challenge-platform|verify (?:that )?you are human/i;

export function wedoTrackingUrl(raw: string): string {
  return WEDO_ENDPOINT + '?packageNo=' + encodeURIComponent(normalizeWedoNumber(raw));
}

export class WedoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeWedoNumber(raw);
    const url = wedoTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number) => parseWedo(await fetchAllegroTracking(url, {
      provider: PROVIDER, signal, timeoutMs, language: 'en-US', strictRoute: true, challengePattern: CHALLENGE,
      fetcher: this.options.fetcher, userAgent: this.options.userAgent,
    }), number);
    return runSteps({ carrier: 'wedo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WedoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'wedo', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
