import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, ChallengeError, NoHistoryError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import type { StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, TrawlClient } from '../../core/transport/index.js';
import { normalizeMandaeNumber, parseMandae, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { awsWafAction } from '../../core/transport/awsWaf.js';

export { normalizeMandaeNumber, parseMandae } from './parser.js';

const MAX_REPLY_BYTES = 1_000_000;

export function mandaeTrackingUrl(raw: string): string {
  return `https://rastreae.com.br/resultado/${encodeURIComponent(normalizeMandaeNumber(raw))}`;
}

export function mandaeApiUrl(raw: string): string {
  return `https://rastreae.api.mandae.com.br/v2/rastreamentos/${encodeURIComponent(normalizeMandaeNumber(raw))}`;
}

/** The page's own request for the whole code, with nothing added. */
function matchesCapture(url: string, number: string): boolean {
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && !parsed.hash && !parsed.search && parsed.href === mandaeApiUrl(number);
  } catch { return false; }
}

export class MandaeTracker {
  constructor(private readonly options: { trawl: TrawlClient | null; timeoutMs?: number; recorder?: StepRecorder }) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeMandaeNumber(raw);
    const budgetMs = context.budgetMs ?? this.options.timeoutMs ?? 45_000;
    if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 60_000) throw new TypeError('Mandaê budget must be between 1 and 60000 ms');
    context.signal?.throwIfAborted();
    if (budgetMs <= TRAWL_TRANSPORT_ALLOWANCE_MS) throw new BudgetExceededError(PROVIDER, budgetMs);
    const trawl = this.options.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Mandaê requires the browser tracking service');
    return runSteps({ carrier: 'mandae', budgetMs, signal: context.signal, recorder: this.options.recorder }, [{
      id: 'trawl', run: async ({ signal, remainingMs }) => {
        const timeoutMs = Math.floor(remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS);
        if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, budgetMs);
        const page = await trawl.scrape({ url: mandaeTrackingUrl(number), skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [mandaeApiUrl(number)], settleTimeout: Math.min(timeoutMs, 20_000),
        }, { provider: 'TRAWL while fetching Mandaê', timeoutMs, signal, maxBytes: 6_000_000, requireSolved: false, allowHttpStatuses: [404, 410] });
        signal.throwIfAborted();
        if (![2, 3].includes(page.tier) || page.statusCode !== 200) throw new TransportError(PROVIDER, 'The browser service did not load Rastreaê');
        // AWS WAF answers the page's first call with a challenge (202); the page's script solves it and asks again.
        const captures = page.capturedResponses.filter((capture) => matchesCapture(capture.url, number)
          && !(capture.status === 202 && awsWafAction(capture.headers) === 'challenge'));
        if (!captures.length) throw new ChallengeError(PROVIDER, 'Rastreaê\'s page sent no answered tracking request; AWS WAF\'s check did not pass');
        if (captures.length > 10) throw new SchemaError(PROVIDER, 'Mandaê returned too many tracking responses');
        const capture = captures[captures.length - 1]!;
        if (capture.status === 429) {
          throw new RateLimitedError(PROVIDER, retryAfterMs(capture.headers['retry-after'], { dates: false }));
        }
        // 405 is AWS WAF's picture CAPTCHA, 403 its block.
        if ([401, 403, 405].includes(capture.status) || awsWafAction(capture.headers)) throw new ChallengeError(PROVIDER);
        // The page reads a 404 as a code Rastreaê does not know.
        if (capture.status === 404) throw new NoHistoryError(PROVIDER, 'Mandaê holds no record of the code', { reason: 'portal_not_found' });
        if (capture.status >= 400) throw new UpstreamHttpError(PROVIDER, capture.status);
        if (capture.status !== 200 || capture.error || capture.truncated || capture.base64Encoded || capture.body === null) {
          throw new TransportError(PROVIDER, 'Mandaê returned an incomplete tracking response');
        }
        if (new TextEncoder().encode(capture.body).length > MAX_REPLY_BYTES) throw new SchemaError(PROVIDER, 'Mandaê returned an unexpectedly large response');
        let payload: unknown;
        try { payload = JSON.parse(capture.body); } catch { throw new SchemaError(PROVIDER, 'Mandaê returned invalid tracking JSON'); }
        return parseMandae(payload, number);
      },
    }]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new MandaeTracker({ trawl: environment.trawl, recorder: environment.recorder });
  return { id: 'mandae', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
