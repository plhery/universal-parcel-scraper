import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LIBANPOST_MAX_BYTES, normalizeLibanPostNumber, parseLibanPost, PROVIDER } from './parser.js';

/** The guest page used by the Android tracking screen, independent of its account API. */
export const LIBANPOST_ENDPOINT = 'https://www.libanpost.com/TrackandTraceMobile.aspx';
const MOVED = [301, 302, 303, 307, 308, 404, 410];

export class LibanPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeLibanPostNumber(raw);
    const url = `${LIBANPOST_ENDPOINT}?${new URLSearchParams({ sn: number, lang: '2' })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: LIBANPOST_MAX_BYTES,
        redirect: 'manual', allowHttpStatuses: MOVED, fetcher: this.options.fetcher });
      // The working page answers unknown items with HTTP 200 and a dedicated notice.
      if (MOVED.includes(response.status)) throw new TransportError(PROVIDER, 'LibanPost tracking page is unavailable', { status: response.status });
      return parseLibanPost(decodeText(bytes), number);
    };
    return runSteps({ carrier: 'libanpost', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LibanPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'libanpost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => normalizeLibanPostNumber(number))),
  };
};
