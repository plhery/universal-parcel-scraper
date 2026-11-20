import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.molace.com';
const portal = origin + '/TRK/Search';
const endpoint = origin + '/TRK/SearchResult';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const bill = input.number.trim().toUpperCase().replace(/^MOLU/, '');
    if (!/^\d{11}$/.test(bill)) throw new InvalidInputError(provider, 'Enter the 11-digit MOL ACE bill of lading');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        // The public form uses zero for an anonymous lookup.
        const body = new URLSearchParams({
          UserId: '0', SearchBy: 'BL', SearchString: bill, OrderAscDesc: 'ASC',
          OrderBy: 'VIN_NO', PageIndex: '1', PageSize: '15', HitSearch: 'Y',
        });
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', Origin: origin, Referer: portal, 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': userAgentOf(environment.userAgent),
          },
          body, signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 750_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'MOL ACE refused the guest bill lookup');
        return parseTracking(decodeText(bytes), bill);
      },
    }]);
  },
});
