import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://speedexfastcargo.com/track.php';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{1,20}$/.test(number)) throw new InvalidInputError(provider, 'Enter a numeric Speedex Fast Cargo docket');
    const url = new URL(portal);
    url.searchParams.set('awb', number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 450_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'Speedex Fast Cargo requires verification');
        }
        return parseTracking(body, number);
      },
    }]);
  },
});
