import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, ChallengeError, NoHistoryError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { normalizePostaMoldoveiNumber, parsePostaMoldovei, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export { normalizePostaMoldoveiNumber, parsePostaMoldovei } from './parser.js';

const MAX_REPLY_BYTES = 1_000_000;

export function postaMoldoveiTrackingUrl(raw: string): string {
  return `https://posta.md/en/track-trace/mailing/${encodeURIComponent(normalizePostaMoldoveiNumber(raw))}`;
}

export function postaMoldoveiApiUrl(raw: string): string {
  return `https://trimiteri-api.posta.md/public/track/${encodeURIComponent(normalizePostaMoldoveiNumber(raw))}`;
}

/** The page's own request for the whole number, with nothing added. */
function matchesCapture(url: string, number: string): boolean {
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && !parsed.hash && !parsed.search && parsed.href === postaMoldoveiApiUrl(number);
  } catch { return false; }
}

export class PostaMoldoveiTracker {
  constructor(private readonly options: { trawl: TrawlClient | null; timeoutMs?: number; recorder?: StepRecorder }) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizePostaMoldoveiNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Poșta Moldovei budget must be between 1 and 60000 ms');
    context.signal?.throwIfAborted();
    if (budgetMs <= TRAWL_TRANSPORT_ALLOWANCE_MS) throw new BudgetExceededError(PROVIDER, budgetMs);
    const trawl = this.options.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Poșta Moldovei requires the browser tracking service');
    return runSteps({ carrier: 'posta-moldovei', budgetMs, signal: context.signal, recorder: this.options.recorder }, [{
      id: 'trawl', run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.floor(remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS);
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, budgetMs);
        const page = await trawl.scrape({ url: postaMoldoveiTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [postaMoldoveiApiUrl(number)], settleTimeout: Math.min(timeoutMs, 20_000),
        }, { provider: 'TRAWL while fetching Poșta Moldovei', timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false });
        signal.throwIfAborted();
        if (![2, 3].includes(page.tier) || page.statusCode !== 200) throw new TransportError(PROVIDER, 'The browser service did not load Poșta Moldovei tracking');
        const captures = page.capturedResponses.filter((capture) => matchesCapture(capture.url, number) && capture.status !== 204);
        // The page asks only once its Turnstile check has passed.
        if (!captures.length) throw new ChallengeError(PROVIDER, 'Poșta Moldovei\'s page sent no tracking request; its Turnstile check did not pass');
        if (captures.length > 10) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned too many tracking responses');
        const capture = captures[captures.length - 1]!;
        if (capture.status === 429) {
          throw new RateLimitedError(PROVIDER, retryAfterMs(capture.headers['retry-after'], { dates: false }));
        }
        if ([401, 403].includes(capture.status)) throw new ChallengeError(PROVIDER);
        // "Not found." answers an item the tracker does not hold and a request whose Turnstile token
        // it refused alike, so it confirms no absence.
        if (capture.status === 404) throw new NoHistoryError(PROVIDER, 'Poșta Moldovei holds no record of the item, or refused the check');
        if (capture.status >= 400) throw new UpstreamHttpError(PROVIDER, capture.status);
        if (capture.status !== 200 || capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
          throw new TransportError(PROVIDER, 'Poșta Moldovei returned an incomplete tracking response');
        }
        if (new TextEncoder().encode(capture.body).length > MAX_REPLY_BYTES) throw new SchemaError(PROVIDER, 'Poșta Moldovei returned an unexpectedly large response');
        let payload: unknown;
        try { payload = JSON.parse(capture.body); } catch { throw new SchemaError(PROVIDER, 'Poșta Moldovei returned invalid tracking JSON'); }
        return parsePostaMoldovei(payload, number);
      },
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new PostaMoldoveiTracker({ trawl: environment.trawl, recorder: environment.recorder });
  return { id: 'posta-moldovei', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
