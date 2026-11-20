import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://certipostal.fivesoftcolombia.com';
const page = origin + '/tag_detail_v1.html';
const endpoint = 'https://certi2.api.fivesoftcolombia.com/fivepostal/api/v1.0/public/tag/v3/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,15}$/.test(number)) throw new InvalidInputError(provider, 'Enter a numeric Certipostal guide');
    const query = new URLSearchParams({ d: number });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + number, {
          headers: { Accept: 'application/json', Origin: origin, Referer: page + '?' + query.toString(), 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 650_000, allowHttpStatuses: [403, 404],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Certipostal refused the guest lookup');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
