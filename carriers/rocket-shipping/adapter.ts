import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[1-9]\d{5,14}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Rocket Shipping load number');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = new URL('https://tracking.rocketshipping.io/.netlify/functions/tracking');
        url.searchParams.set('loadId', number);
        const { bytes } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(decodeText(bytes))) {
          throw new ChallengeError(provider, 'Rocket Shipping requires verification');
        }
        return parseTracking(parseJsonBytes(bytes, provider), number);
      },
    }]);
  },
});
