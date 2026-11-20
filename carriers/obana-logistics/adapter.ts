import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'obana-logistics';
const endpoint = 'https://obana-logistics-t6qg.onrender.com/shipments/public/track/';
const homepage = 'https://logistics.obana.africa';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,64}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'Obana Logistics requires the shipment reference');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(endpoint + encodeURIComponent(number), {
          signal, headers: {
            Accept: 'application/json', Origin: homepage, Referer: homepage + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          redirect: 'error', allowHttpStatuses: [404],
        });
        return parseTracking(decodeText(bytes), response.status, number);
      },
    }]);
  },
});
