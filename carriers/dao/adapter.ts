import { accepted, recognizeFromLookup, type AdapterEnvironment, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, carrierErrorKind, ChallengeError, IndeterminateError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { DAO_MAX_BYTES, normalizeDaoNumber, parseDao, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

// The public page uses its WordPress nonce and a fresh single-use Turnstile token.
export const DAO_ENDPOINT = 'https://dao.as/wp-json/dao-wp/v1/track-parcel';
// A WordPress or edge block page instead of the service's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access denied|403 Forbidden)|cf-chl-|cf-turnstile|captcha/i;

/** The service's address for one number, with English wording. */
export function daoTrackingUrl(raw: string): string {
  return `${DAO_ENDPOINT}?${new URLSearchParams({ barcode: normalizeDaoNumber(raw).number, lang: 'EN' })}`;
}

export class DaoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; trawl?: AdapterEnvironment['trawl'] } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const url = daoTrackingUrl(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      let bytes: Uint8Array;
      let status: number;
      try {
        // Keep the cheap HTTP path for an unchallenged service; verification stays native in the browser.
        ({ bytes, response: { status } } = await fetchBounded(url, { signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) } },
        { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: DAO_MAX_BYTES, fetcher: this.options.fetcher,
          allowHttpStatuses: [400] }));
      } catch (error) {
        // An unknown number is {"found":false}; a missing route is not a missing parcel.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'DAO tracking service is unavailable', { cause: error });
        }
        throw error;
      }
      let payload: unknown;
      try { payload = parseJsonBytes(bytes, PROVIDER); }
      catch (cause) {
        if (BLOCKED.test(decodeText(bytes.subarray(0, 64_000)))) throw new ChallengeError(PROVIDER, 'DAO answered with a block page', { cause });
        throw new SchemaError(PROVIDER, 'DAO returned invalid tracking JSON', { cause });
      }
      // The service names a request it cannot read, such as one without a number.
      if (status === 400) throw new IndeterminateError(PROVIDER, 'DAO rejected the tracking request');
      return parseDao(payload, raw);
    };
    // A request that fails to reach DAO, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: 'dao', budgetMs: context.budgetMs ?? (this.options.trawl ? 90_000 : 15_000), signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(Math.min(15_000, remainingMs))) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, this.options.trawl ? Math.min(7500, remainingMs) : remainingMs)),
      { id: 'trawl', enabled: !!this.options.trawl, recovers: error => carrierErrorKind(error) === 'challenge',
        run: ({ signal, remainingMs }) => this.browser(raw, signal, remainingMs) },
    ]);
  }
  private async browser(raw: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.options.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'DAO needs the browser tracking service');
    const number = normalizeDaoNumber(raw).number;
    const url = `https://dao.as/en/track-your-parcel/#q=${number}`, api = daoTrackingUrl(number);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
    if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [api], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.options.fetcher, maxBytes: 4 * DAO_MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'DAO left its tracking page');
      const replies = page.capturedResponses.filter(row => row.url === api);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'DAO returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'DAO did not bind the whole tracking request');
      const row = replies.at(-1);
      if (row) {
        if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'DAO refused guest verification', { status: row.status });
        if (row.status === 400) throw new IndeterminateError(PROVIDER, 'DAO rejected the tracking request');
        const retryAfter = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter);
        if ([0, 404, 410].includes(row.status)) throw new TransportError(PROVIDER, 'DAO tracking service is unavailable', { status: row.status });
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter);
        if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'DAO returned invalid tracking JSON');
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > DAO_MAX_BYTES) throw new TransportError(PROVIDER, 'DAO returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'DAO returned invalid tracking JSON'); }
        return parseDao(data, number);
      }
      if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'DAO refused its guest page', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if ([404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'DAO guest page is unavailable', { status: page.statusCode });
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (['dao-runtime', 'dao-capture_missing'].includes(reason)) throw new TransportError(PROVIDER, 'DAO could not capture its guest reply');
      throw new ChallengeError(PROVIDER, 'DAO did not finish browser verification', { reason: 'verification_unfinished' });
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }

}

export const adapter: AdapterFactory = (environment) => {
  const options = { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent };
  const tracker = new DaoTracker({ ...options, trawl: environment.trawl });
  const http = new DaoTracker(options);
  return {
    id: 'dao', recordsSteps: true, steps: ['direct', 'retry', 'trawl'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => http.fetch(number, context),
      () => accepted(() => normalizeDaoNumber(number))),
  };
};
