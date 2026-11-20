import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, readFormToken, SEARCH_URL } from './parser.js';

const carrier = 'logexim-express';
const origin = 'https://www.logeximexpress.kz';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,10}$/.test(number)) throw new InvalidInputError(carrier, 'Logexim Express requires a numeric waybill');

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const jar = new CookieJar();
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, jar);
        const userAgent = userAgentOf(environment.userAgent);
        const read = async (url: string, init: RequestInit) => {
          try {
            return await fetchBounded(url, { ...init, signal }, {
              provider: carrier, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
              maxBytes: 256 * 1024, redirect: 'error',
            });
          } catch (error) {
            // Keep guest cookies and CSRF headers out of transport diagnostics.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
            throw error;
          }
        };

        const form = await read(SEARCH_URL, { headers: { Accept: 'text/html', 'User-Agent': userAgent } });
        const token = readFormToken(decodeText(form.bytes));
        if (!(await jar.getCookies(SEARCH_URL)).some(cookie => cookie.key === 'logeximexpress-session')) {
          throw new IndeterminateError(carrier, 'Logexim Express did not issue a guest session');
        }
        const reply = await read(origin + '/ajax/trackInvoice', {
          method: 'POST',
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin,
            Referer: SEARCH_URL, 'User-Agent': userAgent, 'X-CSRF-TOKEN': token,
          },
          body: JSON.stringify({ invoice_number: number }),
        });
        return parseTracking(decodeText(reply.bytes), number);
      },
    }]);
  },
});
