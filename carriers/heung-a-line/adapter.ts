import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { assertKnownBooking, parseTracking, provider } from './parser.js';

const portal = 'https://ebiz.heungaline.com/Tracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^HASL[A-Z0-9]{12}$/.test(number)) throw new InvalidInputError(provider, 'Enter a full Heung-A bill of lading number');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const readGuest = async (url: URL, accept: string) => {
          const { bytes, response } = await fetchBounded(url.href, {
            headers: { Accept: accept, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
          }, { provider, timeoutMs: Math.max(1, deadline - performance.now()), fetcher: environment.fetcher, maxBytes: 800_000, allowHttpStatuses: [403] });
          if (response.status === 403) throw new ChallengeError(provider, 'Heung-A refused the guest tracking request');
          return decodeText(bytes);
        };
        const preflight = new URL('/Home/chkExistsBooking', portal);
        preflight.searchParams.set('bkno', number);
        assertKnownBooking(await readGuest(preflight, 'application/json'));
        const details = new URL(portal);
        details.searchParams.set('blno', number);
        return parseTracking(await readGuest(details, 'text/html'), number);
      },
    }]);
  },
});
