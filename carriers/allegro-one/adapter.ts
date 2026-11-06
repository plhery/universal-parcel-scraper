import { accepted, readerLanguage, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { fetchAllegroTracking } from './client.js';
import { normalizeAllegroOneNumber, parseAllegroOne, PROVIDER } from './parser.js';

// The service the Allegro Delivery tracking page asks through its edge gateway.
// `/one/tracking`, which the older Allegro One page asked, leaves out sorting-centre scans.
export const ALLEGRO_ONE_ENDPOINT = 'https://edge.allegro.pl/ad/tracking';

export function allegroOneTrackingUrl(raw: string): string {
  return `${ALLEGRO_ONE_ENDPOINT}?packageNo=${encodeURIComponent(normalizeAllegroOneNumber(raw))}`;
}

/**
 * The languages the service words its scans in, as `Accept-Language` asks:
 * `pl-PL`, `*` or a bare `en` gets Polish and `en-US` English.
 */
const LANGUAGES = { en: 'en-US', pl: 'pl-PL' } as const;

export class AllegroOneTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** `language` words the scans; the status map reads both. */
  async fetch(raw: string, context: TrackingContext = {}, language: keyof typeof LANGUAGES = 'en'): Promise<CarrierResult> {
    const url = allegroOneTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const reply = await fetchAllegroTracking(url, { provider: PROVIDER, signal, timeoutMs,
        language: LANGUAGES[language], fetcher: this.options.fetcher, userAgent: this.options.userAgent });
      return parseAllegroOne(reply, raw);
    };
    // A request that fails to reach Allegro, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'allegro-one', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AllegroOneTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'allegro-one', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context, readerLanguage(input, ['pl']) ?? 'en'),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeAllegroOneNumber(number))),
  };
};
