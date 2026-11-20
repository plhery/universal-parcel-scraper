import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { akasaPortal } from './parser.js';
import { normalizeSmartKargoNumber, parseSmartKargoTracking, smartKargoFormFields, type SmartKargoPortal } from './smartKargo.js';

export function smartKargoAdapter(portal: SmartKargoPortal): AdapterFactory {
  const { provider, tracker } = portal;
  return environment => ({
    id: provider,
    recordsSteps: true,
    steps: ['direct'],
    async track(input, context = {}) {
      const number = normalizeSmartKargoNumber(input.number, portal);
      return runSteps({
        carrier: provider, recorder: environment.recorder, signal: context.signal,
        budgetMs: context.budgetMs ?? 15_000,
      }, [{
        id: 'direct',
        async run({ signal, remainingMs }) {
          const deadline = performance.now() + remainingMs;
          const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) };
          const read = async (init: RequestInit) => {
            signal.throwIfAborted();
            const left = Math.floor(deadline - performance.now());
            if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
            try {
              const { bytes } = await fetchBounded(tracker, { ...init, signal }, {
                provider, timeoutMs: left, maxBytes: 750_000, fetcher: environment.fetcher,
              });
              return decodeText(bytes);
            } catch (error) {
              // The shared diagnostics can contain the temporary ASP.NET form state.
              if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
              if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
              throw error;
            }
          };
          const page = await read({ method: 'GET', headers });
          const body = smartKargoFormFields(page, number, portal).toString();
          const html = await read({ method: 'POST', body, headers: {
            ...headers, 'Content-Type': 'application/x-www-form-urlencoded',
            Origin: new URL(tracker).origin, Referer: tracker,
          } });
          return parseSmartKargoTracking(html, number, portal);
        },
      }]);
    },
  });
}

export const adapter = smartKargoAdapter(akasaPortal);
