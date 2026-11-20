import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.tborder.com/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{5,30}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a TPL Korea house waybill');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(portal + 'freight/hawb_tracking/' + number, {
          signal,
          headers: { Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 450_000, allowHttpStatuses: [403, 404],
        });
        const html = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(html)) {
          throw new ChallengeError(provider, 'TPL Korea requires verification');
        }
        if (response.status === 404) throw new NotFoundError(provider);
        return parseTracking(html, number);
      },
    }]);
  },
});
