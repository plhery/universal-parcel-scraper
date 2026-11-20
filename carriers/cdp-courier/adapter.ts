import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseFormState, parseTracking, provider, endpoint } from './parser.js';

const portal = 'https://cdpcourier.com/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{7,8}$/.test(number) || /^0+$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a CDP Courier tracking reference');
    }

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const options = {
          provider, fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [403],
        };
        const page = await fetchBounded(portal, {
          headers: { Accept: 'text/html', 'User-Agent': userAgent }, signal,
        }, { ...options, timeoutMs: remainingMs });
        if (page.response.status === 403) throw new ChallengeError(provider, 'CDP Courier refused the guest form');
        const security = parseFormState(decodeText(page.bytes));

        const reply = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', Referer: portal, 'User-Agent': userAgent,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: new URLSearchParams({ action: 'cdp_tracking', security, payload_data: number }), signal,
        }, { ...options, timeoutMs: Math.max(1, deadline - performance.now()) });
        if (reply.response.status === 403) throw new ChallengeError(provider, 'CDP Courier refused the guest tracking request');
        return parseTracking(decodeText(reply.bytes));
      },
    }]);
  },
});
