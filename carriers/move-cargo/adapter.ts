import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase().replace(/^MC-?(\d{6})$/, 'MC-$1');
    if (!/^[A-Z0-9-]{3,80}$/.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a Move Cargo tracking reference');
    }
    const url = new URL('https://movecargo.ca/track');
    url.searchParams.set('tracking_number', reference);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'text/html' },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        return parseTracking(decodeText(bytes), reference);
      },
    }]);
  },
});
