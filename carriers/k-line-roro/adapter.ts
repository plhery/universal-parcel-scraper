import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseBooking, parseTracking, provider } from './parser.js';

const endpoint = 'https://apps.klineglobalroro.com/tracking/api/';
const portal = 'https://apps.klineglobalroro.com/tracking/search';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const bill = input.number.trim().toUpperCase();
    if (!/^KKLU[A-Z0-9]{6,22}$/.test(bill)) throw new InvalidInputError(provider, 'Enter the full KKLU bill from K Line');
    const query = new URLSearchParams({ inputValue: bill });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const headers = { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) };
        const options = { provider, fetcher: environment.fetcher, maxBytes: 1_500_000 };
        const suggestion = await fetchBounded(endpoint + 'suggestion?' + query.toString(), { headers, signal }, {
          ...options, timeoutMs: remainingMs, allowHttpStatuses: [400, 403],
        });
        if (suggestion.response.status === 403) throw new ChallengeError(provider, 'K Line refused the bill lookup');
        const booking = parseBooking(decodeText(suggestion.bytes), bill, suggestion.response.status);

        const detail = await fetchBounded(endpoint + 'bl/KKLU/' + bill.slice(4) + '/' + booking, { headers, signal }, {
          ...options, timeoutMs: Math.max(1, deadline - performance.now()), allowHttpStatuses: [403],
        });
        if (detail.response.status === 403) throw new ChallengeError(provider, 'K Line refused the movement lookup');
        return parseTracking(decodeText(detail.bytes), bill);
      },
    }]);
  },
});
