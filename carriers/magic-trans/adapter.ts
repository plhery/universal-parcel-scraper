import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizeMagicTransNumber, parseMagicTrans, PROVIDER } from './parser.js';

export const MAGIC_TRANS_ORIGIN = 'https://magic-trans.ru';
/** The tracker, which fills its input from the address and posts the number back to the same address. */
export const magicTransPageUrl = (number: string): string => `${MAGIC_TRANS_ORIGIN}/otsledit-gruz/?${new URLSearchParams({ id: number })}`;

export class MagicTransTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeMagicTransNumber(raw);
    return runSteps({ carrier: 'magic-trans', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 70_000 + TRAWL_TRANSPORT_ALLOWANCE_MS }, [
      { id: 'trawl', run: ({ signal, remainingMs }) => this.browser(number, signal, remainingMs) },
    ]);
  }

  // The tracker answers only with a token from Yandex's slider check, so the page loads in the browser service,
  // which drags the slider, lets the page post the number, and hands back only that number's reply.
  private async browser(number: string, signal: AbortSignal, remainingMs: number): Promise<CarrierResult> {
    const trawl = this.environment.trawl;
    if (!trawl) throw new ChallengeError(PROVIDER, 'Magic Trans needs the browser tracking service');
    const url = magicTransPageUrl(number);
    const allowance = Math.min(TRAWL_TRANSPORT_ALLOWANCE_MS, Math.max(1000, Math.floor(remainingMs / 10)));
    const timeoutMs = Math.floor(Math.min(60_000, remainingMs - allowance));
    if (timeoutMs < 15_000) throw new BudgetExceededError(PROVIDER, remainingMs);
    try {
      const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [url], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
        fetcher: this.environment.fetcher, maxBytes: 4 * MAX_BYTES, requireSolved: false, captureWindow: 'last' });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Magic Trans left its tracker');
      const replies = page.capturedResponses.filter(row => row.url === url);
      if (replies.length > 2) throw new SchemaError(PROVIDER, 'Magic Trans returned too many tracking replies');
      if (replies.some(row => row.trackingNumberSubmitted !== number)) throw new SchemaError(PROVIDER, 'Magic Trans did not bind the whole tracking request');
      const row = replies.at(-1);
      const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
      const reason = isRecord(timing) && typeof timing.reason === 'string' ? timing.reason : '';
      if (row) {
        if ([401, 403, 428, 503].includes(row.status) || row.error === 'challenge-html') {
          throw new ChallengeError(PROVIDER, 'Magic Trans refused guest verification', { status: row.status });
        }
        const retry = Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1];
        const ms = retry === undefined ? NaN : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        const retryAfterMs = Number.isFinite(ms) ? Math.max(0, ms) : undefined;
        if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfterMs);
        if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfterMs);
        if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
          || new TextEncoder().encode(row.body).byteLength > MAX_BYTES) throw new TransportError(PROVIDER, 'Magic Trans returned incomplete tracking data');
        let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Magic Trans returned an unreadable page'); }
        if (!isRecord(data) || data.wrapper !== true) throw new SchemaError(PROVIDER, 'Magic Trans answered without its tracker');
        // A token the tracker does not accept leaves its result hidden, as the page is before a lookup.
        if (data.captchaError === true || data.shown !== true) throw new ChallengeError(PROVIDER, 'Magic Trans refused the check token');
        return parseMagicTrans(data, number);
      }
      if ([401, 403, 428, 503].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Magic Trans refused its tracker', { status: page.statusCode });
      if (page.statusCode === 429) throw new RateLimitedError(PROVIDER);
      if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
      if (reason === 'magic-trans-unverified') throw new ChallengeError(PROVIDER, 'Magic Trans check did not pass');
      if (reason === 'magic-trans-runtime') throw new TransportError(PROVIDER, 'Magic Trans could not open its tracker');
      throw new TransportError(PROVIDER, 'Magic Trans did not capture its tracking reply');
    } catch (error) {
      // The outer browser-service request can contain the input or session state.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new MagicTransTracker(environment);
  return { id: 'magic-trans', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
