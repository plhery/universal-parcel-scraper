import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded } from '../../core/transport/boundedFetch.js';
import { userAgentOf } from '../../core/transport/userAgent.js';
import { normalizeVXpressNumber, parseVXpress, PROVIDER, TRACKING_URL } from './parser.js';

export class VXpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; recorder?: StepRecorder } = {}) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeVXpressNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(TRACKING_URL, { method: 'POST', signal,
        body: new URLSearchParams({ iTrackingNumber: number, isTrace: '1' }).toString(),
        headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache',
          Pragma: 'no-cache', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 1024 * 1024,
        redirect: 'manual', allowHttpStatuses: [301, 302, 303, 307, 308, 401, 403, 404, 410] });
      signal.throwIfAborted();
      if (response.status === 403) throw new ChallengeError(PROVIDER, 'V-Xpress refused guest tracking');
      if (response.status !== 200) throw new TransportError(PROVIDER, 'V-Xpress tracking is unavailable', { status: response.status });
      if (response.url && response.url !== TRACKING_URL) throw new SchemaError(PROVIDER, 'V-Xpress returned another tracking route');
      const html = decodeText(bytes).replace(/^\uFEFF/, '');
      if (response.headers.get('cf-mitigated') === 'challenge' || /_cf_chl_opt|cf-turnstile|hcaptcha|grecaptcha|<title>\s*(?:Just a moment|Access Denied|Attention Required)|verify (?:that )?you are human|checking your browser|security verification|verification page/i.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'V-Xpress returned browser verification');
      return parseVXpress(html, number);
    };
    return runSteps({ carrier: 'v-xpress', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}
export const adapter: AdapterFactory = environment => {
  const tracker = new VXpressTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent, recorder: environment.recorder });
  return { id: 'v-xpress', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
