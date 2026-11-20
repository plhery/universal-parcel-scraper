import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'flow-progressive-logistics';
const origin = 'https://www.flowpl.com';
const trackingUrl = origin + '/order-tracking/';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,48}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'FLOW requires the waybill number from the shipping confirmation');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(trackingUrl, {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded',
            Origin: origin, Referer: trackingUrl, 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: new URLSearchParams({ ref_num: number }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 512 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
