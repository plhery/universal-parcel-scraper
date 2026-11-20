import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'astral-aviation';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const match = /^485-?(\d{8})$/.exec(input.number.trim());
    if (!match) throw new InvalidInputError(carrier, 'Astral Aviation requires an AWB beginning with 485');
    const number = '485' + match[1];
    const url = new URL('https://fr8manage.app/dashboard-widget-detail/awbTracking');
    url.searchParams.set('awbNo', number);
    url.searchParams.set('userSchema', 'gsatier2');

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'application/json', Origin: 'https://astral.fr8booking.com',
            Referer: 'https://astral.fr8booking.com/', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
