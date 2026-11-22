import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { GEL_MAX_BYTES, normalizeGelNumber, parseGel, PROVIDER } from './parser.js';

/** GEL's tracking page, which reads the number from its address. */
export const GEL_TRACKING = 'https://www.gel-express.de/de/sendungsverfolgung/';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracking page for one number, as GEL's header search opens it. */
export function gelTrackingUrl(raw: string): string {
  return `${GEL_TRACKING}?${new URLSearchParams({ snr: normalizeGelNumber(raw) })}`;
}

export class GelTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = gelTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'de-DE,de;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: GEL_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
      // Cloudflare fronts the site and answers a browser check with HTTP 403 or 503.
      if (response.status === 403 || response.status === 503) {
        if (response.headers.get('cf-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'GEL Express answered with a browser check');
        throw new TransportError(PROVIDER, 'GEL Express refused the lookup', { status: response.status });
      }
      // The page answers an unknown number with HTTP 200; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'GEL Express tracker is unavailable', { status: response.status });
      return parseGel(decodeText(bytes), raw);
    };
    // A read that fails to reach GEL, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'gel-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers GEL for a number, so preflight
// never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new GelTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'gel-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
