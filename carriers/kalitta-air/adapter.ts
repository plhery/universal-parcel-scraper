import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { USER_ZONE, formNumber, normalizeKalittaAirNumber, parseKalittaAirTracking, provider } from './parser.js';

const origin = 'https://kalitta-cnm.com';
const tracker = `${origin}/tracktrace/`;
const search = `${tracker}default.aspx`;
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|cf-chl|_Incapsula_Resource|\/_sec\/cp_challenge/i;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeKalittaAirNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const left = Math.floor(remainingMs);
        if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
        // The form the tracker's page posts. Its cookie sets the zone the tracker converts its own messages to;
        // without it they come in Central European time.
        const { response, bytes } = await fetchBounded(search, {
          method: 'POST', signal,
          headers: {
            Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `usertz=${USER_ZONE}`,
            Origin: origin, Referer: tracker, 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: new URLSearchParams({ txtAWB: formNumber(number), action: 'SearchAWB' }).toString(),
        }, { provider, fetcher: environment.fetcher, timeoutMs: left, maxBytes: 1_000_000, allowHttpStatuses: [403] });
        const body = decodeText(bytes);
        if (response.status === 403) {
          throw new ChallengeError(provider, verification.test(body) ? 'Kalitta Air returned a verification page' : 'Kalitta Air refused the request');
        }
        return parseKalittaAirTracking(body, number);
      },
    }]);
  },
});
