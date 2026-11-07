import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, type TrawlClient } from '../../core/transport/trawl.js';
import { COSTCO_API, COSTCO_MAX_BYTES, costcoTrackingUrl, isCostcoBlockPage, normalizeCostcoLogisticsNumber, parseCostcoLogisticsBody, PROVIDER } from './parser.js';

function httpFailure(status: number, headers: Record<string, string> = {}): void {
  const retry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const retryAfterMs = retry === undefined ? undefined : /^\d+$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  if (status === 429) throw new RateLimitedError(PROVIDER, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : undefined);
  if ([401, 403, 412, 428].includes(status)) throw new ChallengeError(PROVIDER, 'Costco Logistics refused browser tracking', { status });
  // The API's explicit HTTP 200 envelope identifies a missing parcel, not a missing route.
  if (status === 404 || status === 410) throw new TransportError(PROVIDER, 'Costco Logistics tracking route is unavailable', { status });
  if (status >= 400) throw new UpstreamHttpError(PROVIDER, status);
  if (status !== 200) throw new TransportError(PROVIDER, 'Costco Logistics tracking is unavailable', { status });
}

export class CostcoLogisticsTracker {
  constructor(private readonly options: { trawl?: TrawlClient | null; fetcher?: typeof fetch; recorder?: StepRecorder } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCostcoLogisticsNumber(raw), url = costcoTrackingUrl(number), api = COSTCO_API + number;
    return runSteps({ carrier: 'costco-logistics', budgetMs: context.budgetMs ?? 50_000,
      signal: context.signal, recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      if (!this.options.trawl) throw new ChallengeError(PROVIDER, 'Costco Logistics requires the browser tracking service');
      const timeoutMs = Math.floor(Math.min(30_000, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 1) throw new BudgetExceededError(PROVIDER, remainingMs);
      const page = await this.options.trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [api], settleTimeout: 8000 }, { provider: PROVIDER, signal, timeoutMs, fetcher: this.options.fetcher,
        requireSolved: false, allowHttpStatuses: [401, 403, 404, 410, 412, 428, 429, 503], captureWindow: 'last',
        maxBytes: COSTCO_MAX_BYTES * 8 + 65_536 });
      signal.throwIfAborted();
      httpFailure(page.statusCode);
      // The official client scrolls an absent result by adding this fragment.
      // The complete query and captured API identity must still match.
      if (![2, 3].includes(page.tier) || typeof page.raw.url !== 'string' || (page.url !== url && page.url !== `${url}#norecords`)) throw new TransportError(PROVIDER, 'Costco Logistics did not return the requested browser page');
      // The final reply in the bounded sequence stands, including a later refusal.
      const replies = page.capturedResponses.filter(reply => reply.url === api && reply.status !== 204), reply = replies.at(-1);
      if (!reply) {
        if (isCostcoBlockPage(page.html)) throw new ChallengeError(PROVIDER, 'Costco Logistics has not completed browser verification');
        throw new TransportError(PROVIDER, 'Costco Logistics returned no matching tracking response');
      }
      httpFailure(reply.status, reply.headers);
      if (replies.length > 10 || reply.error || reply.truncated || reply.base64Encoded || reply.body === null) throw new TransportError(PROVIDER, 'Costco Logistics returned an incomplete tracking response');
      if (new TextEncoder().encode(reply.body).byteLength > COSTCO_MAX_BYTES) throw new SchemaError(PROVIDER, 'Costco Logistics returned excessive tracking data');
      return parseCostcoLogisticsBody(reply.body, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CostcoLogisticsTracker({ trawl: environment.trawl, fetcher: environment.fetcher, recorder: environment.recorder });
  return { id: 'costco-logistics', recordsSteps: true, steps: ['trawl'], track: (input, context) => tracker.fetch(input.number, context) };
};
