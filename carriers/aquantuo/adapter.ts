import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import type { TrawlClient } from '../../core/transport/trawl.js';
import { trawlPageStep } from '../../core/transport/trawlPage.js';
import { AQUANTUO_CHALLENGE, normalizeAquantuoNumber, parseAquantuo, PROVIDER } from './parser.js';

// The page with its menus and a long history stays well under this.
const MAX_BYTES = 1_000_000;
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracking page of one id. */
export const aquantuoTrackingUrl = (raw: string): string =>
  `https://aquantuo.com/track-order?package_id=${encodeURIComponent(normalizeAquantuoNumber(raw))}`;

export class AquantuoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAquantuoNumber(raw);
    const url = aquantuoTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 429] });
      const html = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER);
      if (response.status === 403 || AQUANTUO_CHALLENGE.test(html.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'Aquantuo answered with a browser check', { status: response.status });
      }
      if (response.status !== 200) throw new TransportError(PROVIDER, `Aquantuo's tracking page is unavailable`, { status: response.status });
      return parseAquantuo(html, number);
    };
    // Cloudflare checks the page's visitors, so a check the direct read meets goes to the browser
    // service. A read that fails to reach the site gets one more first.
    return runSteps({ carrier: 'aquantuo', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      trawlPageStep({ ...this.options, provider: PROVIDER, url, maxBytes: MAX_BYTES, parse: html => parseAquantuo(html, number) }),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AquantuoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return { id: 'aquantuo', recordsSteps: true, steps: ['direct', 'retry', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
