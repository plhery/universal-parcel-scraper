import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { navlungoNumber, parseNavlungo, PROVIDER } from './parser.js';

const TRACKING_URL = 'https://domestic-track.navlungo.com/en/check/';

export const adapter: AdapterFactory = environment => ({
  id: 'navlungo', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = navlungoNumber(input.number);
    return runSteps({
      carrier: 'navlungo', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = new URL(`${number}/?_rsc`, TRACKING_URL);
        const { bytes, response } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'text/x-component', RSC: '1', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 768_000,
          fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403, 404],
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        const reply = decodeText(bytes);
        if (response.status === 403 || /(?:<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt)/i.test(reply.slice(0, 8192))) {
          throw new ChallengeError(PROVIDER);
        }
        if (!response.headers.get('content-type')?.startsWith('text/x-component')) {
          throw new SchemaError(PROVIDER, 'Expected a Navlungo tracking component response');
        }
        return parseNavlungo(reply, number);
      },
    }]);
  },
});
