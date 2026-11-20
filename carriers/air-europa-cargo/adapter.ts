import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeAirEuropaNumber, parseAirEuropaCargo, PROVIDER } from './parser.js';

const TRACKING_URL = 'https://www.uxtracking.com/tracking.asp';

export const adapter: AdapterFactory = environment => ({
  id: 'air-europa-cargo', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeAirEuropaNumber(input.number);
    return runSteps({
      carrier: 'air-europa-cargo', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(TRACKING_URL, {
          method: 'POST', signal,
          headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
          body: new URLSearchParams({ prefix: number.slice(0, 3), Serial: number.slice(4) }),
        }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 256_000,
          fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403],
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt/i.test(html.slice(0, 8192))) {
          throw new ChallengeError(PROVIDER);
        }
        return parseAirEuropaCargo(html, number);
      },
    }]);
  },
});
