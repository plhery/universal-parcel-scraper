import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'http://elines.hedehk.com/cargoDynamicEN';
const endpoint = 'http://elines.hedehk.com/cargoDynamicNewEN';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) {
      throw new InvalidInputError(provider, 'Enter a Hede Shipping container number');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: { Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          body: new URLSearchParams({ billno: '', cntr: container }),
          signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 650_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Hede refused the equipment lookup');
        return parseTracking(decodeText(bytes), container);
      },
    }]);
  },
});
