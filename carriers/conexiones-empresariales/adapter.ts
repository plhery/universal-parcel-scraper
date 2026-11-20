import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://app.conexionesempresariales.com/rastreo/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,20}$/.test(number)) throw new InvalidInputError(provider, 'Enter a numeric Conexiones Empresariales guide');
    const url = new URL(portal);
    url.searchParams.set('txtguia', number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent), Referer: portal },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 350_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Conexiones Empresariales refused the public lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
