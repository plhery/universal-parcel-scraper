import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://apps.litegua.com/rastreoweb/ge.php';
const endpoint = 'https://apps.litegua.com/rastreoweb/rastreo.php';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{6,}$/.test(number)) throw new InvalidInputError(provider, 'Enter the digits from the Litegua Express electronic guide');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': userAgentOf(environment.userAgent), Origin: new URL(portal).origin, Referer: portal,
          },
          body: new URLSearchParams({ busc: number }),
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 200_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Litegua Express refused the electronic guide search');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
