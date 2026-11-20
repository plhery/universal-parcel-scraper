import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.jpicargo.com/tracking';
const endpoint = 'https://tracker.v2.jpicargo.com/api/search';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,40}$/.test(number)) throw new InvalidInputError(provider, 'Enter the shipment number from the JPI Jakarta Cargo receipt');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `${endpoint}?${new URLSearchParams({ no_resi: number })}`;
        const { bytes, response } = await fetchBounded(url, {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'JPI Jakarta Cargo refused the shipment search');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
