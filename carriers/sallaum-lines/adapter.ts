import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://sallaumlines.com/track-shipment/';
const endpoint = 'https://app.logisoft.io/api/unit/getunitbyserial';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(number)) throw new InvalidInputError(provider, 'Enter the 17-character VIN from Sallaum Lines');
    const query = new URLSearchParams({ line: 'Sallaum Lines Ltd', serial: number });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          headers: {
            Accept: 'application/json', Origin: new URL(portal).origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 400_000, allowHttpStatuses: [403, 404],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Sallaum Lines refused the guest lookup');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
