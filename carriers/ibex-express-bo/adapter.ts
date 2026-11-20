import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'ibex-express-bo';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,15}$/.test(number)) {
      throw new InvalidInputError(carrier, 'IBEX Express requires the digits after the hyphen on an electronic waybill');
    }
    const url = new URL('https://www.ibex.com.bo/forms/rastreo.php');
    url.searchParams.set('guia', number);
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 22_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'application/json', Referer: 'https://www.ibex.com.bo/', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 4 * 1024 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
