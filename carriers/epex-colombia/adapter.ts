import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://epex.com.co';
const search = origin + '/rastrea/';
const endpoint = origin + '/wp-json/epex-connect/v1/tracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{3,20}$/.test(number)) throw new InvalidInputError(provider, 'Enter the numeric guide printed by EPEX');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: search, 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ data: { ReferenciaEntrega: number } }),
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 2_000_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'EPEX refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
