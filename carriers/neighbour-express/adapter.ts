import type { AdapterEnvironment, AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { TRAWL_TRANSPORT_ALLOWANCE_MS } from '../../core/transport/trawl.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';
import { neighbourLookupUrl, neighbourNeedsVerification, neighbourPageUrl, NEIGHBOUR_MAX_BYTES, normalizeNeighbourNumber, parseNeighbour, PROVIDER } from './parser.js';

export class NeighbourExpressTracker {
  constructor(private readonly environment: AdapterEnvironment) {}
  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeNeighbourNumber(raw);
    return runSteps({ carrier: 'neighbour-express', recorder: this.environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 75_000 }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const trawl = this.environment.trawl;
      if (!trawl) throw new ChallengeError(PROVIDER, 'Neighbour Express needs the browser tracking service');
      const started = Date.now(), url = neighbourPageUrl(number), lookup = neighbourLookupUrl(number);
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = remainingMs - (Date.now() - started);
        const timeoutMs = Math.floor(Math.min(40_000, left - TRAWL_TRANSPORT_ALLOWANCE_MS));
        if (timeoutMs < 8000) throw new BudgetExceededError(PROVIDER, left);
        const page = await trawl.scrape({ url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
          captureResponses: [lookup], settleTimeout: timeoutMs }, { provider: PROVIDER, timeoutMs, signal,
          fetcher: this.environment.fetcher, maxBytes: 4 * NEIGHBOUR_MAX_BYTES, requireSolved: false, captureWindow: 'last' }).catch((error: unknown) => {
          signal.throwIfAborted();
          if (error instanceof UpstreamHttpError && [404, 410].includes(error.status)) {
            throw new TransportError(PROVIDER, 'Neighbour Express browser service is unavailable', { status: error.status });
          }
          throw error;
        });
        signal.throwIfAborted();
        if (page.url !== url) throw new SchemaError(PROVIDER, 'Neighbour Express left its return tracker');
        const rows = page.capturedResponses.filter(row => row.url === lookup);
        if (rows.length > 1) throw new SchemaError(PROVIDER, 'Neighbour Express returned too many guest replies');
        const row = rows[0];
        if (row) {
          if (row.trackingNumberSubmitted !== number) throw new SchemaError(PROVIDER, 'The browser did not bind the whole Neighbour Express request');
          const retry = retryAfterMs(Object.entries(row.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]);
          if ([401, 403, 428].includes(row.status) || row.error === 'challenge-html') throw new ChallengeError(PROVIDER, 'Neighbour Express refused guest verification', { status: row.status });
          if (row.status <= 0 || [404, 410].includes(row.status)) throw new TransportError(PROVIDER, 'Neighbour Express tracking is unavailable', { ...(row.status ? { status: row.status } : {}) });
          if (row.status !== 200) throw new UpstreamHttpError(PROVIDER, row.status, retry);
          if (row.error === 'invalid-json') throw new SchemaError(PROVIDER, 'Neighbour Express returned invalid JSON');
          if (row.error || row.truncated || row.base64Encoded || typeof row.body !== 'string'
            || new TextEncoder().encode(row.body).byteLength > NEIGHBOUR_MAX_BYTES) throw new TransportError(PROVIDER, 'Neighbour Express returned incomplete tracking data');
          let data: unknown; try { data = JSON.parse(row.body); } catch { throw new SchemaError(PROVIDER, 'Neighbour Express returned invalid JSON'); }
          // A new context can obtain a different native v3 score. Retry this exact refusal once,
          // only while there is time for a fresh guest run; AJ verification is not assumed passed.
          if (attempt === 0 && neighbourNeedsVerification(data)
            && remainingMs - (Date.now() - started) - TRAWL_TRANSPORT_ALLOWANCE_MS >= 20_000) continue;
          return parseNeighbour(data, number);
        }
        if ([0, 404, 410].includes(page.statusCode)) throw new TransportError(PROVIDER, 'Neighbour Express tracking page is unavailable');
        if ([401, 403, 428].includes(page.statusCode)) throw new ChallengeError(PROVIDER, 'Neighbour Express refused its tracker', { status: page.statusCode });
        if (page.statusCode !== 200) throw new UpstreamHttpError(PROVIDER, page.statusCode);
        const timing: unknown = Array.isArray(page.raw.timings) ? page.raw.timings.at(-1) : undefined;
        if (isRecord(timing) && ['neighbour-runtime', 'neighbour-network'].includes(String(timing.reason))) {
          throw new TransportError(PROVIDER, 'Neighbour Express could not complete its guest request');
        }
        throw new ChallengeError(PROVIDER, 'Neighbour Express guest verification did not finish', { reason: 'verification_unfinished' });
      }
      throw new ChallengeError(PROVIDER, 'Neighbour Express requires guest verification');
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new NeighbourExpressTracker(environment);
  return { id: 'neighbour-express', steps: ['trawl'], recordsSteps: true, track: (input, context) => tracker.fetch(input.number, context) };
};
