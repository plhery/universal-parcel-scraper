import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, readFormToken, SEARCH_URL, SUBMIT_URL } from './parser.js';

const carrier = 'paqueteria-vencedor';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{10}$/.test(number)) throw new InvalidInputError(carrier, 'Paquetería Vencedor requires a ten-digit guide');

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const jar = new CookieJar();
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, jar);
        const headers = { Accept: 'text/html', 'Accept-Language': 'es-MX', 'User-Agent': userAgentOf(environment.userAgent) };
        const read = async (url: string, init: RequestInit, allowRedirect = false) => {
          try {
            return await fetchBounded(url, { ...init, signal }, {
              provider: carrier, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
              maxBytes: 512 * 1024, redirect: 'manual',
              ...(allowRedirect && { allowHttpStatuses: [302, 303] }),
            });
          } catch (error) {
            // Bounded-fetch diagnostics can include the guest session or form token.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
            throw error;
          }
        };

        const form = await read(SEARCH_URL, { headers });
        const token = readFormToken(decodeText(form.bytes));
        if (!(await jar.getCookies(SEARCH_URL)).some(cookie => cookie.key === 'laravel-session')) {
          throw new IndeterminateError(carrier, 'Paquetería Vencedor did not issue a guest session');
        }

        const sent = await read(SUBMIT_URL, {
          method: 'POST',
          headers: { ...headers, Origin: new URL(SEARCH_URL).origin, Referer: SEARCH_URL,
            'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ _token: token, tracknumber: number }),
        }, true);
        if (sent.response.status === 200) return parseTracking(decodeText(sent.bytes), number);

        const location = sent.response.headers.get('location');
        if (location !== SEARCH_URL && location !== '/paqueteria') {
          throw new IndeterminateError(carrier, 'Paquetería Vencedor did not redirect to its guest tracker');
        }
        const result = await read(SEARCH_URL, { headers });
        return parseTracking(decodeText(result.bytes), number);
      },
    }]);
  },
});
