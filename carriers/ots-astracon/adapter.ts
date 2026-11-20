import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { astraconNumber, parseAstracon, PROVIDER } from './parser.js';

const TRACKING_URL = 'https://www-oaoosf.wisegrid.net/Glow/api/tracker/trackerList';

export const adapter: AdapterFactory = environment => ({
  id: 'ots-astracon', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = astraconNumber(input.number);
    return runSteps({
      carrier: 'ots-astracon', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(TRACKING_URL, {
          method: 'POST',
          signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ trackingNumbers: [number], trackingKeys: [] }),
        }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 512_000,
          fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403],
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt/i.test(decodeText(bytes.subarray(0, 8192)))) {
          throw new ChallengeError(PROVIDER);
        }
        return parseAstracon(parseJsonBytes(bytes, PROVIDER), number);
      },
    }]);
  },
});
