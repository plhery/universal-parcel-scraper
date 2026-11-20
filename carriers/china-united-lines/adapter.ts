import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseBooking, parseTracking, provider } from './parser.js';

const portal = 'https://www.culines.com/en/site/bill';
const endpoint = 'https://www.culines.com/search/getCommon';
const cargoService = 'https://eservice.culines.com/gnoss/CUP_HOM_3301GS.do';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) throw new InvalidInputError(provider, 'Enter a CU Lines container number');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 25_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const fetchSearch = async (query: Record<string, string>) => {
          const url = new URL(endpoint);
          url.search = new URLSearchParams({ address_url: cargoService, curl_type: 'post', ...query }).toString();
          const { bytes, response } = await fetchBounded(url.href, {
            headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
          }, { provider, timeoutMs: Math.max(1, deadline - performance.now()), fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [403], retryTransient: true, deadline });
          if (response.status === 403) throw new ChallengeError(provider, 'CU Lines refused the cargo tracking request');
          return decodeText(bytes);
        };

        const booking = parseBooking(await fetchSearch({ f_cmd: '122', cntr_no: container }));
        const movements = await fetchSearch({
          f_cmd: '125', cntr_no: container, bkg_no: booking.bkgNo, cop_no: booking.copNo,
        });
        return parseTracking(movements, booking.copNo);
      },
    }]);
  },
});
