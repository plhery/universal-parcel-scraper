import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://oyh-exp.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter an Ou Yi Hang waybill or bill of lading');
    }
    const url = new URL('/api/public/tracking/' + encodeURIComponent(number), origin);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'application/json', Referer: origin + '/en/tracking', 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 500_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Ou Yi Hang refused the public tracking lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
