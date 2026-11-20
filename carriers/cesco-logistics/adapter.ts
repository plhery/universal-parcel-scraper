import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'cesco-logistics';
const origin = 'https://cesco-logistics.com';
const trackingPage = origin + '/tracking.php';

export const adapter: AdapterFactory = environment => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const parts = /^(\d{3})-?(\d{8})$/.exec(input.number.trim());
    if (!parts) throw new InvalidInputError(carrier, 'CESCO requires the eleven-digit air waybill');
    const number = `${parts[1]}-${parts[2]}`;
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(origin + '/tracking-post.php', {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', Origin: origin, Referer: trackingPage, 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': userAgentOf(environment.userAgent), 'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ q: number }),
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 256 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
