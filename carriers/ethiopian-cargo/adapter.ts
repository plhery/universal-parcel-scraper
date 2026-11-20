import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://cargo.ethiopianairlines.com/my-cargo/track-your-shipment';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '');
    if (!/^071\d{8}$/.test(number)) throw new InvalidInputError(provider, 'Enter an Ethiopian Cargo air waybill beginning with 071');
    const serial = number.slice(3);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(`${portal}/Index/`, {
          method: 'POST',
          headers: {
            Accept: 'text/html',
            Origin: new URL(portal).origin,
            Referer: portal,
            'User-Agent': userAgentOf(environment.userAgent),
          },
          body: new URLSearchParams({ AirwayBilNum: `071-${serial}`, CheckIn: '', CheckOut: '' }),
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Ethiopian Cargo refused the air waybill search');
        return parseTracking(decodeText(bytes), serial);
      },
    }]);
  },
});
