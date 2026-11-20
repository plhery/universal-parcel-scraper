import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.confirmedfreight.com';
const search = origin + '/services/tracking.htm';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Confirmed Freight shipment reference');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/track/' + encodeURIComponent(number) + '/', {
          signal,
          headers: { Accept: 'text/html', Referer: search, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 700_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Confirmed Freight refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
