import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const provider = 'tamex';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[13]\d{13}$/.test(number)) throw new InvalidInputError(provider, 'Invalid tracking number format');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = 'https://tamex.com.sa/track/' + number;
        const { bytes, response } = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 512 * 1024, allowHttpStatuses: [404, 410],
        });
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
