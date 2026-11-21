import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
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
          const read = async (url: string | URL, init: RequestInit, redirects = false) => {
            signal.throwIfAborted();
            const left = Math.floor(deadline - performance.now());
            if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
            try {
              const { bytes, response } = await fetchBounded(url, { ...init, signal }, {
                provider, timeoutMs: left, maxBytes: 750_000, fetcher: environment.fetcher,
                ...(redirects ? { redirect: 'manual' as const, allowHttpStatuses: [302] } : {}),
              });
              return { html: decodeText(bytes), response };
            } catch (error) {
              // The shared diagnostics can contain the temporary ASP.NET form state.
              if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
              if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
              throw error;
            }
          };
          if (portal.route === 'link') {
            const url = new URL(tracker);
            url.search = new URLSearchParams({ AWBPrefix: number.slice(0, 3), AWBNo: number.slice(3) }).toString();
            const first = await read(url, { method: 'GET', headers }, true);
            if (first.response.status !== 302) return parseSmartKargoTracking(first.html, number, portal);
            // The tracker swaps the query for an encrypted one on the same page.
            const location = first.response.headers.get('location');
            const next = location ? URL.parse(location, url) : null;
            if (!next || next.origin + next.pathname !== url.origin + url.pathname || next.username || next.password
              || !next.searchParams.get('encrpt') || !next.searchParams.get('AWBPrefix') || !next.searchParams.get('AWBNo')) {
              throw new SchemaError(provider, 'The tracker redirected away from its tracking page');
            }
            const { html } = await read(next, { method: 'GET', headers });
            return parseSmartKargoTracking(html, number, portal);
          }
          const { html: page } = await read(tracker, { method: 'GET', headers });
          const body = smartKargoFormFields(page, number, portal).toString();
          const { html } = await read(tracker, { method: 'POST', body, headers: {
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
