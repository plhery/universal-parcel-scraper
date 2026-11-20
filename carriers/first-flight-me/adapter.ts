import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { pageHttpError } from '../../core/transport/trawl.js';
import { normalizeNumber, parseTracking, PROVIDER } from './parser.js';

const API = 'https://webapi.firstflightme.com/api/user/track-by-awb';

export const adapter: AdapterFactory = environment => ({
  id: 'first-flight-me',
  recordsSteps: true,
  steps: ['trawl'],
  track: (input, context = {}) => {
    context.signal?.throwIfAborted();
    const number = normalizeNumber(input.number);
    return runSteps({
      carrier: 'first-flight-me', signal: context.signal, budgetMs: context.budgetMs ?? 40_000,
      recorder: environment.recorder,
    }, [{ id: 'trawl', run: async ({ signal, remainingMs }) => {
      const trawl = environment.trawl;
      if (!trawl) throw new ChallengeError(PROVIDER, 'First Flight needs the browser tracking service');
      const timeoutMs = Math.min(35_000, Math.floor(remainingMs * 0.85));
      if (timeoutMs < 1000) throw new BudgetExceededError(PROVIDER, remainingMs);
      const url = `https://firstflightme.com/tracking/awb/${number}`;
      const page = await trawl.scrape({
        url, skipHttp: true, maxTier: 3, maxTimeout: timeoutMs,
        captureResponses: [API], settleTimeout: Math.min(timeoutMs, 10_000),
      }, { provider: PROVIDER, signal, timeoutMs, fetcher: environment.fetcher, maxBytes: 2_000_000 }).catch((error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof UpstreamHttpError && error.kind === 'not_found') {
          throw new TransportError(PROVIDER, 'First Flight’s waybill page is unavailable', { status: error.status });
        }
        throw error;
      });
      signal.throwIfAborted();
      if (page.url !== url) throw new SchemaError(PROVIDER, 'First Flight left the requested waybill page');
      const replies = page.capturedResponses.filter(response => response.url === API);
      if (replies.length !== 1) throw new IndeterminateError(PROVIDER, 'First Flight did not return one waybill reply');
      const response = replies[0]!;
      if (response.status === 404 || response.status === 410) {
        throw new TransportError(PROVIDER, 'First Flight’s tracking endpoint is unavailable', { status: response.status });
      }
      if (response.status !== 200) throw pageHttpError(PROVIDER, response.status, response.headers);
      if (response.error || response.truncated || response.base64Encoded || response.body === null) {
        throw new SchemaError(PROVIDER, 'First Flight returned an incomplete browser reply');
      }
      return parseTracking(response.body, number);
    } }]);
  },
});
