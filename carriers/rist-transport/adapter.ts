import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://ltl-tracking.risttransport.com/boldetail.htm';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{5,15}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a numeric RIST Transport PRO number');
    }
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ nav: 'top', wbtn: 'PRO', wpro1: number }).toString();
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 950_000, allowHttpStatuses: [403, 404],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'RIST Transport requires verification');
        }
        if (response.status === 404) throw new NotFoundError(provider);
        return parseTracking(body, number);
      },
    }]);
  },
});
