import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, trackingCodePattern } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const code = input.number.trim().toLowerCase();
    if (!trackingCodePattern.test(code)) {
      throw new InvalidInputError(provider, 'Enter the 32-character tracking code from a Fraktjakt shipment link');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(`https://www.fraktjakt.se/trace/shipment/${code}?locale=en`, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, timeoutMs: remainingMs, maxBytes: 256 * 1024,
          allowHttpStatuses: [403, 404, 410], fetcher: environment.fetcher,
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Fraktjakt blocked the tracking request');
        if (response.status === 404 || response.status === 410) throw new NoHistoryError(provider);
        return parseTracking(decodeText(bytes));
      },
    }]);
  },
});
