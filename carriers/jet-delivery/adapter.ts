import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://www.jetdelivery.com/api/v1/utilities/track/';
const search = 'https://www.jetdelivery.com/track/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{5,8}$/.test(number)) throw new InvalidInputError(provider, 'Enter the numeric Jet Delivery shipment number');
    const query = new URLSearchParams({ idx: number });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          headers: { Accept: 'application/json', Referer: search, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 650_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Jet Delivery refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
