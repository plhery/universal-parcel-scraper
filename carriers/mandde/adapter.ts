import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://api.mandde.co/apiv3/getTracking';
const origin = 'https://www.mandde.com.co';
const search = origin + '/rastreo.html';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Za-z0-9]{1,20}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter the MANDDE guide with letters and digits only');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: search, 'User-Agent': userAgentOf(environment.userAgent),
          },
          // MANDDE SAS is company 1 in the public getCurriers catalog.
          body: JSON.stringify({ guia: number, codEmpresa: 1 }),
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'MANDDE refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
