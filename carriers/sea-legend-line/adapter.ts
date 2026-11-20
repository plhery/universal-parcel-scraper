import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.slg-shipping.com/';
const endpoint = new URL('slg-sealegend-rest/containerDynamicForWeb/list.do', portal).href;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Sea Legend container number');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Origin: new URL(portal).origin,
            Referer: portal,
            'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ bkgNo: number }),
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Sea Legend refused the cargo tracking request');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
