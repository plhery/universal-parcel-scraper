import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { geneiNumber, parseGenei, PROVIDER } from './parser.js';

const TRACKING_URL = 'https://apiv2.genei.es/api/v1/tracking/';

export const adapter: AdapterFactory = environment => ({
  id: 'genei', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = geneiNumber(input.number);
    return runSteps({
      carrier: 'genei', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(new URL(number, TRACKING_URL), {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 512_000,
          fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403],
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (response.status === 403 || /(?:<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt)/i.test(decodeText(bytes.subarray(0, 8192)))) {
          throw new ChallengeError(PROVIDER);
        }
        return parseGenei(parseJsonBytes(bytes, PROVIDER), number);
      },
    }]);
  },
});
