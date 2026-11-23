import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeOdmGuide, ODM_MAX_BYTES, parseOdm, PROVIDER } from './parser.js';

/** ODM's result page, which reads the guide from its address and draws the answer on the server. */
export const ODM_TRACKING = 'https://odmexpress.com.mx/rastreo-2/';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The result page for one guide, as ODM's tracking form opens it. */
export function odmTrackingUrl(raw: string): string {
  return `${ODM_TRACKING}?${new URLSearchParams({ rastreo_fall: normalizeOdmGuide(raw) })}`;
}

export class OdmTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = odmTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'es-MX,es;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: ODM_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
      if (response.status === 403 || response.status === 503) {
        if (response.headers.get('cf-mitigated') === 'challenge') throw new ChallengeError(PROVIDER, 'ODM Express answered with a browser check');
        throw new TransportError(PROVIDER, 'ODM Express refused the lookup', { status: response.status });
      }
      // The page answers an unknown guide with HTTP 200; a 404 or a redirect is a moved route.
      if (!response.ok) throw new TransportError(PROVIDER, 'ODM Express tracker is unavailable', { status: response.status });
      return parseOdm(decodeText(bytes), raw);
    };
    // A read that fails to reach ODM, or hangs, gets one more try: the first
    // gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'odm-express', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers ODM for a number, so preflight
// never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new OdmTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'odm-express', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
