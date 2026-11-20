import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.eimskip.com/find-shipment/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = /^(?:EIMU[ -]?)?(L\d{8})$/.exec(input.number.trim().toUpperCase())?.[1];
    if (!number) throw new InvalidInputError(provider, 'Enter an Eimskip shipment number');
    const url = new URL(portal);
    url.searchParams.set('id', number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) }, signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 1_000_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Eimskip refused the shipment search');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
