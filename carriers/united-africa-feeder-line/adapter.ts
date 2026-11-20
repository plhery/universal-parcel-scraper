import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.uaflshipping.com/Tracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const booking = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,30}$/.test(booking)) {
      throw new InvalidInputError(provider, 'Enter a United Africa Feeder Line booking or bill of lading number');
    }
    const url = new URL(portal);
    url.searchParams.set('BookingNo', booking);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 750_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'UAFL refused the booking lookup');
        return parseTracking(decodeText(bytes), booking);
      },
    }]);
  },
});
