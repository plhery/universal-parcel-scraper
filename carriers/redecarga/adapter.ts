import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, SEARCH_URL } from './parser.js';

const carrier = 'redecarga';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,32}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'Redecarga requires the complete guide from the shipping receipt');
    }
    const url = new URL(SEARCH_URL);
    url.searchParams.set('guia', number);
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'text/html', 'Accept-Language': 'es-CO', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 512 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
