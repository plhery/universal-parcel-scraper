import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, referencePattern } from './parser.js';

const portal = 'https://portal.spedition-moeller.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!referencePattern.test(reference)) {
      throw new InvalidInputError(provider, 'Enter an 18-digit NVE, optionally prefixed with the two GS1 application digits 00');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded('https://api.spedition-moeller.com/v1/public/tracking-live', {
          signal, method: 'POST', headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ nve: reference, locale: 'de-DE' }),
        }, {
          provider, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          allowHttpStatuses: [403], fetcher: environment.fetcher,
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Artur Möller blocked the tracking request');
        return parseTracking(parseJsonBytes(bytes, provider), reference);
      },
    }]);
  },
});
