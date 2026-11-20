import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://myg2.g2ocean.com';
const endpoint = 'https://api.myg2.g2ocean.com/api/public-bol-shipment';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^(?:GSSW)?[A-Z]{3}\d{5}[A-Z]$/.test(number)) throw new InvalidInputError(provider, 'Enter a G2 Ocean bill of lading');
    const bill = number.replace(/^GSSW/, '');
    const url = new URL(endpoint);
    url.searchParams.set('bol_name', bill);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: {
            Accept: 'application/json', Origin: portal, Referer: portal + '/', 'User-Agent': userAgentOf(environment.userAgent),
          }, signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 1_000_000, allowHttpStatuses: [403, 422] });
        if (response.status === 403) throw new ChallengeError(provider, 'G2 Ocean refused the guest bill search');
        return parseTracking(decodeText(bytes), bill, response.status);
      },
    }]);
  },
});
