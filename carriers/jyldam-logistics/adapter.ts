import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'jyldam-logistics';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const match = /^JL-?(20\d{2})-?(\d{1,10})$/.exec(input.number.trim().toUpperCase());
    if (!match) throw new InvalidInputError(carrier, 'Jyldam requires its full JL shipment number, including the year');
    const [, year, serial] = match;
    const url = new URL('https://jyldam-logistics.kz/api/v1/track/JL-' + year + '-' + serial + '/');
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url, {
          signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 128 * 1024,
          redirect: 'error', allowHttpStatuses: [404],
        });
        return parseTracking(decodeText(bytes), response.status, year!, serial!);
      },
    }]);
  },
});
