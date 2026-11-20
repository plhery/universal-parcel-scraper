import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, referencePattern } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase();
    if (!referencePattern.test(reference)) throw new InvalidInputError(provider, 'Enter a GlobKurier GK tracking reference');
    const url = new URL('https://api.globkurier.pl/v1/order/tracking');
    url.searchParams.set('orderNumber', reference);
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url, {
          signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, allowHttpStatuses: [400, 403], maxBytes: 512 * 1024 });
        const body = decodeText(bytes);
        if (response.status === 403 || (/^\s*</.test(body)
          && /_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)/i.test(body))) {
          throw new ChallengeError(provider, 'GlobKurier blocked the public tracking lookup');
        }
        return parseTracking(parseJsonBytes(bytes, provider), response.status);
      },
    }]);
  },
});
