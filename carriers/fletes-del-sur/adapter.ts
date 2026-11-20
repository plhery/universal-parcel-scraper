import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'fletes-del-sur';
const origin = 'https://www.fletesdelsur.com';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{7}$/.test(number)) {
      throw new InvalidInputError(carrier, 'PFS requires the seven-digit guide from the shipping receipt');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(origin + '/api/rastreo-guia', {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': userAgentOf(environment.userAgent), Origin: origin, Referer: origin + '/rastreo',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({ guia: number, 'g-recaptcha-response': '' }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 2 * 1024 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
