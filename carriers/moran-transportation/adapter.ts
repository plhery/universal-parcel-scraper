import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { maxBytes, parseTracking } from './parser.js';

const provider = 'moran-transportation';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^\d{10}$/.test(number)) throw new InvalidInputError(provider, 'Invalid tracking number format');
    return runSteps({ carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000 }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = 'https://tracking.carrierlogistics.com/scripts/mor.pol/protracexml.htm?' + new URLSearchParams({ pronum: number }).toString();
        const { bytes, response } = await fetchBounded(url, { signal, headers: { 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes, allowHttpStatuses: [404, 410],
        });
        return parseTracking(decodeText(bytes, 'windows-1252'), number, response.status);
      },
    }]);
  },
});
