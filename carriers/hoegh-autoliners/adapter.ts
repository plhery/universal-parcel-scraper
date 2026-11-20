import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.hoeghautoliners.com/my-cargo';
const endpoint = 'https://www.hoeghautoliners.com/api/cargo';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const bill = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,30}$/.test(bill)) throw new InvalidInputError(provider, 'Enter the bill of lading from Höegh Autoliners');
    const query = new URLSearchParams({ search: bill });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 2_000_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Höegh Autoliners refused the guest lookup');
        return parseTracking(decodeText(bytes), bill);
      },
    }]);
  },
});
