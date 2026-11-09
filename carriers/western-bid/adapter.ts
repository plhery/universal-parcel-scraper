import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { trawlPrivateScrape } from '../../core/transport/trawlPrivate.js';
import { normalizeWesternBidNumber, parseWesternBid, PROVIDER, validateWesternBidUrl, WESTERN_BID_MAX_BYTES, WESTERN_BID_READY, westernBidApiUrl, westernBidTrackingUrl } from './parser.js';

export class WesternBidTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeWesternBidNumber(raw), url = westernBidTrackingUrl(number), api = westernBidApiUrl(number);
    if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Western Bid requires the browser tracking service');
    return runSteps({ carrier: 'western-bid', budgetMs: context.budgetMs ?? 60_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const maxTimeout = Math.floor(Math.min(35_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (maxTimeout < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
      const page = await trawlPrivateScrape(this.options.trawl!, {
        url, skipHttp: true, maxTier: 3, maxTimeout, contentWaitForSelector: WESTERN_BID_READY,
        captureResponses: [api], settleTimeout: 5000,
      }, { provider: PROVIDER, timeoutMs: maxTimeout, signal, fetcher: this.options.fetcher,
        maxBytes: WESTERN_BID_MAX_BYTES * 8 + 65_536, captureWindow: 'last' });
      signal.throwIfAborted();
      if (typeof page.raw.url !== 'string') throw new TransportError(PROVIDER, 'Western Bid returned no bound tracking address');
      validateWesternBidUrl(page.url, number);
      // Retain the final matching status: an earlier HTML result must not hide
      // a later verification refusal or rate limit. The browser's DOM remains
      // usable when the service safely omits an unknown-sized capture body.
      const matching = page.capturedResponses.filter(entry => entry.url === api);
      const latest = matching.at(-1);
      if (latest && latest.status !== 200) {
        if ([401, 403].includes(latest.status)) throw new ChallengeError(PROVIDER, 'Western Bid refused tracking verification', { status: latest.status });
        if (latest.status === 429) {
          const retry = Object.entries(latest.headers).find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
          const ms = retry && /^\d{1,8}$/.test(retry.trim()) ? Number(retry) * 1000 : undefined;
          throw new RateLimitedError(PROVIDER, ms);
        }
        throw new TransportError(PROVIDER, 'Western Bid tracking lookup is unavailable', { status: latest.status || undefined });
      }
      return parseWesternBid(page.html, number, page.url);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new WesternBidTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'western-bid', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
