import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://dpscargo.co.id/lacak';
const endpoint = 'https://dpscargo.co.id/api/lacak';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const match = /^DPS-?(\d{6})-?(\d{6})$/i.exec(input.number.trim());
    if (!match) throw new InvalidInputError(provider, 'Enter the full DPS Cargo shipment number');
    const number = `DPS-${match[1]}-${match[2]}`;
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            'User-Agent': userAgentOf(environment.userAgent), Origin: new URL(portal).origin, Referer: portal,
          },
          body: JSON.stringify({ resi: number }),
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 200_000, allowHttpStatuses: [403, 404] });
        if (response.status === 403) throw new ChallengeError(provider, 'DPS Cargo refused the shipment search');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
