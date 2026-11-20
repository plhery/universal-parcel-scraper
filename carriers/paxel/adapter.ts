import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, RateLimitedError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS, trawlOutOfTime, type TrawlScrapeResponse } from '../../core/transport/trawl.js';
import { isRecord } from '../../core/types.js';
import { MAX_BYTES, normalizePaxelNumber, PAGE, parsePaxel, PROVIDER } from './parser.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

const SERVICE_MS = 40_000;
const MAX_CAPTURES = 12;

function retryAfter(headers: Record<string, string>): number | undefined {
  return retryAfterMs(Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]);
}

function reason(page: TrawlScrapeResponse): string {
  const last: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
  return isRecord(last) && typeof last.reason === 'string' ? last.reason : '';
}

function noCapture(page: TrawlScrapeResponse): never {
  if (page.statusCode === 429) {
    const headers = isRecord(page.raw.responseHeaders)
      ? Object.fromEntries(Object.entries(page.raw.responseHeaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    throw new RateLimitedError(PROVIDER, retryAfter(headers));
  }
  if ([401, 403, 428].includes(page.statusCode) || reason(page) === 'paxel-verification_unfinished') {
    throw new ChallengeError(PROVIDER, 'Paxel did not finish browser verification', { status: page.statusCode, reason: 'verification_unfinished' });
  }
  // An HTTP endpoint's absence says nothing about whether this AWB exists.
  if (page.statusCode === 0 || [404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'Paxel tracking is unavailable', { status: page.statusCode });
  if (page.statusCode >= 400) throw new UpstreamHttpError(PROVIDER, page.statusCode);
  throw new TransportError(PROVIDER, 'Paxel did not capture its whole-bound tracking reply', { reason: 'capture_missing' });
}

export class PaxelTracker {
  constructor(private readonly environment: AdapterEnvironment) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePaxelNumber(raw), url = PAGE + '?awb_req=' + encodeURIComponent(number);
    return runSteps({ carrier: 'paxel', signal: context.signal, recorder: this.environment.recorder,
      budgetMs: context.budgetMs ?? SERVICE_MS + TRAWL_TRANSPORT_ALLOWANCE_MS }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const trawl = this.environment.trawl;
      if (!trawl) throw new ChallengeError(PROVIDER, 'Paxel needs the browser tracking service');
      const timeoutMs = Math.floor(Math.min(SERVICE_MS, remainingMs - TRAWL_TRANSPORT_ALLOWANCE_MS));
      if (timeoutMs < 1000) throw new BudgetExceededError(PROVIDER, remainingMs);
      let page: TrawlScrapeResponse;
      try {
        page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs, captureResponses: [PAGE] }, {
          provider: PROVIDER, timeoutMs, signal, fetcher: this.environment.fetcher,
          requireSolved: false, captureWindow: 'first', maxBytes: 4 * MAX_BYTES,
          allowHttpStatuses: [400, 401, 403, 404, 410, 419, 422, 428, 429, 500, 502, 503, 504],
        });
      } catch (error) {
        signal.throwIfAborted();
        if (trawlOutOfTime(error)) throw new BudgetExceededError(PROVIDER, remainingMs);
        // The outer service diagnostics can carry the input or browser state.
        if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
          throw new TransportError(PROVIDER, 'The browser tracking service is unavailable', { status: error.status });
        }
        if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
        if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
        throw error;
      }
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'Paxel left its tracking page');
      if (page.capturedResponses.length > MAX_CAPTURES) throw new SchemaError(PROVIDER, 'Paxel returned too many captured replies');
      for (const row of page.capturedResponses) {
        if (row.trackingNumberSubmitted !== undefined && (row.trackingNumberSubmitted !== number || row.url !== PAGE)) {
          throw new SchemaError(PROVIDER, 'Paxel captured another tracking request');
        }
      }
      // Unbound navigation/verification responses do not erase an independently bound form reply.
      const replies = page.capturedResponses.filter(row => row.trackingNumberSubmitted === number && row.url === PAGE);
      if (!replies.length) return noCapture(page);
      if (replies.length !== 1) throw new SchemaError(PROVIDER, 'Paxel returned more than one bound tracking reply');
      const row = replies[0]!;
      if (row.status === 429) throw new RateLimitedError(PROVIDER, retryAfter(row.headers));
      if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') {
        throw new ChallengeError(PROVIDER, 'Paxel refused its guest verification', { status: row.status });
      }
      if (row.status === 0 || [404, 410].includes(row.status)) throw new TransportError(PROVIDER, 'Paxel tracking is unavailable', { status: row.status });
      if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retryAfter(row.headers));
      if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string') {
        const bodyReason = row.error ? 'body_unreadable' : row.truncated ? 'body_truncated' : row.base64Encoded ? 'body_encoding' : 'body_missing';
        throw new TransportError(PROVIDER, 'Paxel returned incomplete tracking HTML', { reason: bodyReason });
      }
      const contentType = Object.entries(row.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
      if (contentType && !/^text\/html(?:\s*;|$)/i.test(contentType)) throw new SchemaError(PROVIDER, 'Paxel changed its tracking reply format');
      return parsePaxel(row.body, number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PaxelTracker(environment);
  return { id: 'paxel', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
