import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { IndeterminateError, InvalidInputError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, readFormToken } from './parser.js';

const carrier = 'icasa-cargo';
const origin = 'https://integracargo.com';
const trackingUrl = origin + '/rastreo/';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const parts = /^(\d{3})[ -]?(\d{8})$/.exec(input.number.trim());
    if (!parts) throw new InvalidInputError(carrier, 'ICASA requires the eleven-digit air waybill');
    const number = `${parts[1]}-${parts[2]}`;
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const jar = new CookieJar();
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, jar);
        const headers = { Accept: 'text/html', 'Accept-Language': 'es-MX', 'User-Agent': userAgentOf(environment.userAgent) };
        const read = async (init: RequestInit) => {
          try {
            const { bytes } = await fetchBounded(trackingUrl, { ...init, signal }, {
              provider: carrier, fetcher, timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
              maxBytes: 512 * 1024, redirect: 'error',
            });
            return decodeText(bytes);
          } catch (error) {
            // The tracking reply must not log the ephemeral guest cookie or form value.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            throw error;
          }
        };

        const form = await read({ headers });
        const token = readFormToken(form);
        if (!(await jar.getCookies(trackingUrl)).some(cookie => cookie.key === 'csrftoken')) {
          throw new IndeterminateError(carrier, 'ICASA did not issue a guest tracking cookie');
        }
        const reply = await read({
          method: 'POST',
          headers: { ...headers, Origin: origin, Referer: trackingUrl, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrfmiddlewaretoken: token, modo_envio: 'aereo', awb: number }),
        });
        return parseTracking(reply, number);
      },
    }]);
  },
});
