import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'pack-express-gt';
const origin = 'https://packexpress.com.gt';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,64}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'Pack Express requires the guide number on its shipping label');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(origin + '/pe-rastreo/rastreo-bridge.php', {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin,
            Referer: origin + '/rastreo-de-envios/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ guia: number }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 512 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
