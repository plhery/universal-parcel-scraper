import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, referencePattern } from './parser.js';

const tracker = 'https://www.marken.com/track-shipment';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase();
    if (!referencePattern.test(reference)) throw new InvalidInputError(provider, 'Enter the Marken tracking ID');
    const query = new URLSearchParams({ jobNumber: reference });
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(`${tracker}?${query}`, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          allowHttpStatuses: [403], fetcher: environment.fetcher,
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Marken blocked the tracking request');
        return parseTracking(decodeText(bytes), reference);
      },
    }]);
  },
});
