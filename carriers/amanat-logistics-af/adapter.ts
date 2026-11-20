import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'amanat-logistics-af';
const portal = 'https://www.amanatlogistics.com/tracking/orders';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^(AM)(\d{4})(INV)(\d{3})$/, '$1-$2-$3-$4');
    if (!/^[A-Z0-9-]{1,48}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'Amanat Logistics requires its tracking number or ACCI invoice number');
    }
    const url = new URL(portal);
    url.search = new URLSearchParams({ lang: 'en', code: number }).toString();
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 512 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
