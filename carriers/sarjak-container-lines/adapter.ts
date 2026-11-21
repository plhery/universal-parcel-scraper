import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { PROVIDER, parseSarjakTracking, SARJAK_MAX_BYTES, sarjakQuery, sarjakResult } from './parser.js';

/** iTrack, the tracking page Sarjak's home page sends a number to. */
export const SARJAK_TRACKING = 'https://eservices.sarjak.com/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|<title>\s*Attention Required/i;

/** iTrack's page for a number, which the home page names by the number in base64. */
export function sarjakTrackingUrl(number: string): string {
  return `${SARJAK_TRACKING}${btoa(number)}`;
}

export class SarjakTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const query = sarjakQuery(raw);
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(sarjakTrackingUrl(query.number), {
        method: 'GET', signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, { provider: PROVIDER, timeoutMs, maxBytes: SARJAK_MAX_BYTES, redirect: 'manual',
        allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 429], fetcher: this.options.fetcher });
      const body = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || CHALLENGE.test(body.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'Sarjak refused its tracking page', { status: response.status });
      }
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Sarjak\'s tracking page is unavailable', { status: response.status });
      return sarjakResult(parseSarjakTracking(body, query));
    };
    // An attempt that fails to reach iTrack, or hangs, gets one more: the first gets half of the
    // budget, so the retry fits in the rest.
    return runSteps({ carrier: 'sarjak-container-lines', budgetMs: context.budgetMs ?? 20_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new SarjakTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'sarjak-container-lines', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
