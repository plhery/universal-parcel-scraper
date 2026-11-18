import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

export const adapter: AdapterFactory = (environment) => ({
  id: 'usea-express', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^USEA\d{14}$/.test(number)) throw new InvalidInputError('usea-express', 'Invalid tracking number format');
    return runSteps({ carrier: 'usea-express', recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = 'https://nxclient.usea56.com/api/express/track/list/' + number;
        const { response, bytes } = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider: 'usea-express', fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 512 * 1024, allowHttpStatuses: [404, 410],
        });
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
