import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://cargotrack.kenya-airways.com/';
const endpoint = 'https://cargotrackapi.kenya-airways.com/AWBTracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '');
    if (!/^706\d{8}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Kenya Airways Cargo air waybill beginning with 706');
    const awb = `706-${number.slice(3)}`;

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: new URL(portal).origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ awbNo: awb }), signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Kenya Airways Cargo refused the air waybill search');
        return parseTracking(decodeText(bytes), awb);
      },
    }]);
  },
});
