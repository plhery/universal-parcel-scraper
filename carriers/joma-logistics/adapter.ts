import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'joma-logistics';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const match = /^JL-?(\d{8})-?(\d{5})$/.exec(input.number.trim().toUpperCase());
    if (!match) throw new InvalidInputError(carrier, 'JOMA requires the JL departure reference from the invoice');
    const number = `JL-${match[1]}-${match[2]}`;
    const url = new URL('https://jomalogisticsnyc.com/api/public-tracking');
    url.searchParams.set('tracking', number);

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 128 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
