import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import { MBE_ES_CHALLENGE, MBE_ES_MAX_BYTES, normalizeMbeEsNumber, parseMbeEs, PROVIDER } from './parser.js';

export { normalizeMbeEsNumber, parseMbeEs } from './parser.js';

/** The tracker page, which reads the code from its address as `c`. */
export const MBE_ES_TRACKER = 'https://www.mbe.es/es/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's page for one code. */
export const mbeEsTrackingUrl = (raw: string): string => `${MBE_ES_TRACKER}?c=${encodeURIComponent(normalizeMbeEsNumber(raw))}`;

export class MbeEsTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const code = normalizeMbeEsNumber(raw);
    const url = mbeEsTrackingUrl(code);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MBE_ES_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 429] });
      const html = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || MBE_ES_CHALLENGE.test(html.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'MBE Spain answered with a browser check', { status: response.status });
      }
      // A redirect is a moved tracker, not a missing shipment.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'MBE Spain tracking moved', { status: response.status });
      return parseMbeEs(html, code);
    };
    // Akamai refuses the site to clients it takes for robots, an HTTP client among them, so a refusal
    // the direct read meets goes to the browser service. A read that fails to reach the site gets one more first.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: MBE_ES_MAX_BYTES, contentWaitForSelector: '.tracking-res',
        parse: (html) => parseMbeEs(html, code) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MbeEsTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
