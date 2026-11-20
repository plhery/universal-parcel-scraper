import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'livra-lynx';
const endpoint = 'https://m-api.livra.tn/api/tracking/parcels';
const origin = 'https://livra.tn';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const written = input.number.trim();
    const num = Number(written);
    if (!/^\d+$/.test(written) || !Number.isSafeInteger(num) || num <= 0) {
      throw new InvalidInputError(carrier, 'Livra Lynx requires a positive numeric parcel number');
    }

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(endpoint, {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: origin + '/suivi/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ num }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          redirect: 'error', allowHttpStatuses: [404],
        });
        return parseTracking(decodeText(bytes), response.status, num);
      },
    }]);
  },
});
