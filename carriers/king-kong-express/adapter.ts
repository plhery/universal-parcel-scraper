import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^(?!0{10}$)\d{10}$/.test(number)) throw new InvalidInputError(provider, 'Enter one King Kong Express waybill');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `https://www.kke.com.hk/home/index/quecode`;
        const { bytes } = await fetchBounded(url, {
          method: 'POST', signal,
          headers: {
            'User-Agent': userAgentOf(environment.userAgent), 'X-Requested-With': 'XMLHttpRequest',
            Referer: 'https://www.kke.com.hk/home/index/que',
          },
          body: new URLSearchParams({ code: number }),
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        return parseTracking(decodeText(bytes));
      },
    }]);
  },
});
