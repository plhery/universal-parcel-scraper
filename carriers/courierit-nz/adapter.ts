import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseStatus, provider, referencePattern, verifyBooking } from './parser.js';

const gateway = 'https://www.courierit.net.nz';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!referencePattern.test(reference)) {
      throw new InvalidInputError(provider, 'Enter a 12-digit Courierit consignment reference');
    }
    const query = new URLSearchParams({ consignmentRef: reference });
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) };
        const options = { provider, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          allowHttpStatuses: [403], fetcher: environment.fetcher };
        const booking = await fetchBounded(`${gateway}/Order/View?${query}`, { signal, headers }, options);
        if (booking.response.status === 403) throw new ChallengeError(provider, 'Courierit blocked the booking lookup');
        verifyBooking(decodeText(booking.bytes), reference);
        const status = await fetchBounded(`${gateway}/Order/OrderViewWithLatestStatus?${query}`, {
          signal, method: 'POST', body: new URLSearchParams(), headers: { ...headers, 'X-Requested-With': 'XMLHttpRequest' },
        }, options);
        if (status.response.status === 403) throw new ChallengeError(provider, 'Courierit blocked the status lookup');
        return parseStatus(decodeText(status.bytes));
      },
    }]);
  },
});
