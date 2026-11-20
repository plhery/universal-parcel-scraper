import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeApmLogisticsNumber, parseApmLogistics, PROVIDER } from './parser.js';

export { normalizeApmLogisticsNumber, parseApmLogistics } from './parser.js';

export const APM_LOGISTICS_ORIGIN = 'https://apmlogistics.id';
/** The tracker page for one waybill, which looks it up as it loads. */
export const apmLogisticsPageUrl = (number: string): string => `${APM_LOGISTICS_ORIGIN}/cek-resi?${new URLSearchParams({ resi: number })}`;
/** The address the page posts every waybill to, with the waybill and its reCAPTCHA token in the form. */
export const apmLogisticsTraceUrl = (): string => `${APM_LOGISTICS_ORIGIN}/api/proxy.php?ep=trace`;

export class ApmLogisticsTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeApmLogisticsNumber(raw);
    return runSteps({ carrier: PROVIDER, recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 60_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // Every lookup carries a reCAPTCHA v3 token, which the tracker page gets for itself, so the page
  // asks and the browser service hands back only that waybill's reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'APM Logistics needs the browser tracking service');
    const url = apmLogisticsPageUrl(number), trace = apmLogisticsTraceUrl();
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(45_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [trace], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'APM Logistics left its tracker page');
      const replies = page.capturedResponses.filter(row => row.url === trace);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'APM Logistics returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'APM Logistics did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        // A missing token, or one reCAPTCHA scores too low, gets "Google Captcha Error", which the helper marks.
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html' || row.error === 'recaptcha-refused') {
          throw new ChallengeError(PROVIDER, 'APM Logistics refused guest verification', { status: row.status });
        }
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'APM Logistics returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'APM Logistics returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'APM Logistics returned invalid tracking JSON'); }
        return parseApmLogistics(data, number);
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'APM Logistics refused its tracker page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (reason === 'apm-logistics-runtime') throw new TransportError(PROVIDER, 'APM Logistics could not open its tracker page');
      throw new TransportError(PROVIDER, 'APM Logistics did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ApmLogisticsTracker(environment);
  return { id: PROVIDER, steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
