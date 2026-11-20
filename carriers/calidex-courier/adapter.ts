import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://calidex.multitrack.trackingpremium.us';
const portal = `${origin}/tracking/tracking`;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9-]{4,40}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Calidex guide number');
    const query = new URLSearchParams({ type: '1', number, user: '0', recibo: '0', guia: '0', consol: '0' });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(`${origin}/tracking/search?${query}`, {
          headers: {
            Accept: 'application/json', Referer: portal, 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': userAgentOf(environment.userAgent),
          }, signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 800_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Calidex refused the guide search');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
