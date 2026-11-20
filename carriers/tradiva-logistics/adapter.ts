import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'tradiva-logistics';
const origin = 'https://tradivalogistics.com';
const trackingUrl = origin + '/tracking-1/';

export const adapter: AdapterFactory = environment => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9 ._/-]{0,63}$/.test(number)) {
      throw new InvalidInputError(carrier, 'Enter a Tradiva shipment or freight reference');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 16_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(trackingUrl, {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', 'Accept-Language': 'ar-EG,ar;q=0.9',
            Origin: origin, Referer: trackingUrl, 'User-Agent': userAgentOf(environment.userAgent),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ tdv_trk_ref: number, tdv_trk_hp: '' }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 896 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
