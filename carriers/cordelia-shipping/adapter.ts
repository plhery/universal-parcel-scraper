import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://cordelialine.com/';
const api = 'https://erp.cordelialine.com/cordelia/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '').toUpperCase();
    const container = /^[A-Z]{4}\d{7}$/.test(number);
    if (!container && !/^[A-Z]{3}[A-Z0-9]{9,27}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Cordelia bill of lading or container number');
    }
    const endpoint = new URL(container ? 'api/byContainer/websearchContainerDtl' : 'app/bltracking/bltracingweb', api);
    endpoint.searchParams.set(container ? 'contno' : 'blno', number);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint.href, {
          headers: { Accept: 'application/json', Origin: new URL(portal).origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 1_000_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Cordelia refused the cargo tracking request');
        return parseTracking(decodeText(bytes), number, container);
      },
    }]);
  },
});
