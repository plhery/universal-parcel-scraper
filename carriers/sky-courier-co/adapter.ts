import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://casillero.skycourier.com.co/track';
const endpoint = 'https://casillero.skycourier.com.co/api/tracking/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const match = /^SKY-?(\d{4})-?(\d{5,10})$/i.exec(input.number.trim());
    if (!match) throw new InvalidInputError(provider, 'Enter a Sky Courier Colombia guide number');
    const number = `SKY-${match[1]}-${match[2]}`;

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(endpoint + encodeURIComponent(number), {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 200_000, allowHttpStatuses: [403, 404] });
        if (response.status === 403) throw new ChallengeError(provider, 'Sky Courier refused the guide lookup');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
