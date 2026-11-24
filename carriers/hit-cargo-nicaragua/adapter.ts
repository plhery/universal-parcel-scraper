import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps, type StepSpec } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { budgetWhenOutOfTime, TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { HIT_CARGO_CHALLENGE, normalizeHitCargoNumber, parseHitCargo, PROVIDER } from './parser.js';

// A reply with a long history stays well under this.
const MAX_BYTES = 256_000;
const REDIRECTS = [301, 302, 303, 307, 308];

/** The tracker's reply for one guía, which the tracking page reads. */
export const hitCargoTrackingUrl = (raw: string): string =>
  `https://api.hit-cargo.com/track/${encodeURIComponent(normalizeHitCargoNumber(raw))}`;

export class HitCargoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: TrawlClient | null } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHitCargoNumber(raw);
    const url = hitCargoTrackingUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', Origin: 'https://hit-cargo.com', Referer: 'https://hit-cargo.com/',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 429] });
      const body = decodeText(bytes);
      if (response.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs(response.headers.get('retry-after')));
      if (response.status === 403 || HIT_CARGO_CHALLENGE.test(body.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'HIT Cargo answered with a browser check', { status: response.status });
      }
      if (response.status !== 200 && response.status !== 404) {
        throw new TransportError(PROVIDER, `HIT Cargo's tracker is unavailable`, { status: response.status });
      }
      return parseHitCargo(body, number);
    };
    // Cloudflare checks the tracker's visitors, so a check the direct read meets goes to the browser
    // service. A read that fails to reach the site gets one more first.
    return runSteps({ carrier: 'hit-cargo-nicaragua', budgetMs: context.budgetMs ?? (this.options.trawl ? 60_000 : 15_000),
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(this.options.trawl ? Math.min(15_000, remainingMs) : remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7_500, remainingMs) : remainingMs)),
      this.browserStep(url, number),
    ]);
  }

  // The browser service opens the reply's own address after the check. An unknown guía's reply
  // comes with HTTP 404, which the service passes on with its body.
  private browserStep(url: string, number: string): StepSpec<CarrierResult> {
    const { trawl, fetcher } = this.options;
    return {
      id: 'trawl', enabled: Boolean(trawl),
      recovers: error => carrierErrorKind(error) === 'challenge',
      run: async ({ signal, remainingMs }) => {
        signal.throwIfAborted();
        const timeoutMs = Math.floor(Math.min(30_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
        const page = await trawl!.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs }, {
          provider: PROVIDER, signal, timeoutMs, fetcher, requireSolved: false, allowHttpStatuses: [404],
          maxBytes: MAX_BYTES * 6 + 65_536,
        }).catch(budgetWhenOutOfTime(PROVIDER, remainingMs));
        signal.throwIfAborted();
        if (new TextEncoder().encode(page.html).byteLength > MAX_BYTES * 2) throw new SchemaError(PROVIDER, 'The browser returned an oversized reply');
        if (page.url !== url) throw new TransportError(PROVIDER, 'The browser redirected the requested reply');
        if (![2, 3].includes(page.tier) || ![200, 404].includes(page.statusCode)) {
          throw new ChallengeError(PROVIDER, 'The browser did not get past the tracker\'s check', { status: page.statusCode });
        }
        return parseHitCargo(page.html, number);
      },
    };
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new HitCargoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent, trawl: environment.trawl });
  return { id: 'hit-cargo-nicaragua', recordsSteps: true, steps: ['direct', 'retry', 'trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
