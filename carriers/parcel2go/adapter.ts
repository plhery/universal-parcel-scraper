import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parcel2goNumber, parseParcel2Go, PROVIDER } from './parser.js';

const TRACKING = 'https://www.parcel2go.com/.api/tracking/PARCEL2GO.UK.LIVE/tracking/';

export const adapter: AdapterFactory = environment => ({
  id: 'parcel2go',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = parcel2goNumber(input.number);
    const url = new URL(number, TRACKING);
    url.search = new URLSearchParams({ postcode: '', findMostRecentParcelTracking: 'true' }).toString();
    return runSteps({
      carrier: 'parcel2go', budgetMs: context.budgetMs ?? 15_000, signal: context.signal, recorder: environment.recorder,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url, {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 1_000_000,
          fetcher: environment.fetcher, redirect: 'error', allowHttpStatuses: [403],
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        if (response.status === 403 || /(?:<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt)/i.test(decodeText(bytes.subarray(0, 8192)))) {
          throw new ChallengeError(PROVIDER);
        }
        return parseParcel2Go(parseJsonBytes(bytes, PROVIDER), number);
      },
    }]);
  },
});
