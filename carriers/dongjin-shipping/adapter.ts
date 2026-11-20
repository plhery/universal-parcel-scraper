import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { parseBooking, parseTracking, provider } from './parser.js';

const portal = 'https://esvc.djship.co.kr/gnoss/CUP_HOM_3301.do?sessLocale=en';
const endpoint = 'https://esvc.djship.co.kr/gnoss/CUP_HOM_3301GS.do';
// The guest endpoint redirects the standard Fetch client to the home page.
// The Node HTTPS transport uses its ordinary root certificates.
const nativeHttps = fetchTrusting([]);

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) throw new InvalidInputError(provider, 'Enter a Dongjin container number');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 25_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const fetcher = transportOf(environment.fetcher) ?? nativeHttps;
        const search = async (query: Record<string, string>) => {
          const { bytes, response } = await fetchBounded(endpoint, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/x-www-form-urlencoded',
              Referer: portal,
              'X-Requested-With': 'XMLHttpRequest',
              'User-Agent': userAgentOf(environment.userAgent),
            },
            body: new URLSearchParams(query), signal,
          }, {
            provider, timeoutMs: Math.max(1, deadline - performance.now()),
            fetcher, maxBytes: 500_000, allowHttpStatuses: [403],
          });
          if (response.status === 403) throw new ChallengeError(provider, 'Dongjin refused the cargo tracking request');
          return decodeText(bytes);
        };

        const booking = parseBooking(await search({ f_cmd: '122', cntr_no: container, cust_cd: '' }));
        const movements = await search({
          f_cmd: '125', cntr_no: container, bkg_no: booking.bkgNo, cop_no: booking.copNo,
        });
        return parseTracking(movements, booking.copNo);
      },
    }]);
  },
});
