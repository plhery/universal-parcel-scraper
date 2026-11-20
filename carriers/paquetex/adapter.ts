import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, REFERENCE } from './parser.js';

const carrier = 'paquetex';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!REFERENCE.test(number)) throw new InvalidInputError(carrier, 'PaquetEx requires its box number or full tracking reference');
    const url = new URL('https://paquetex.net/api/tracking');
    url.searchParams.set('q', number);

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          allowHttpStatuses: [400], redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
