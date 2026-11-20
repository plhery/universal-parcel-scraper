import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^\d{12}$/.test(number)) throw new InvalidInputError(provider, 'Enter a 12-digit INTRAS house bill');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `https://intras.co.jp/delivery/tracking?number=${encodeURIComponent(number)}`;
        const { bytes, response } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher, allowHttpStatuses: [404] });
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
