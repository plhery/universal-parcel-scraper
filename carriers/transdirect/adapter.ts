import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a Transdirect booking or consignment reference');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = new URL(`https://api.transdirect.com.au/api/v5/tracking/${reference}`);
        const { response, bytes } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
        }, {
          provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, allowHttpStatuses: [404],
          fetcher: environment.fetcher,
        });
        const body = decodeText(bytes);
        if (/^\s*</.test(body) && /cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(body)) {
          throw new ChallengeError(provider, 'Transdirect returned a browser verification page');
        }
        return parseTracking(parseJsonBytes(bytes, provider), reference, response.status);
      },
    }]);
  },
});
