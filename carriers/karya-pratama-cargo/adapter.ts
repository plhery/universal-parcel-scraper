import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://karyapratamacargo.co.id/cek-resi/';
const endpoint = 'https://api.karyapratamacargo.co.id/api/index.php';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Za-z0-9]{1,50}$/.test(number)) throw new InvalidInputError(provider, 'Enter the shipment number from the Karya Pratama Cargo receipt');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `${endpoint}?${new URLSearchParams({ route: 'tracking/track', no_resi: number })}`;
        const { bytes, response } = await fetchBounded(url, {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 200_000, allowHttpStatuses: [403, 404] });
        if (response.status === 403) throw new ChallengeError(provider, 'Karya Pratama Cargo refused the shipment search');
        return parseTracking(decodeText(bytes), number, response.status);
      },
    }]);
  },
});
