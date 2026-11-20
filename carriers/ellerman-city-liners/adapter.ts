import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const widget = 'https://app.orcapayments.app';
const endpoint = 'https://api.orcapayments.app/container_tracking';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) throw new InvalidInputError(provider, 'Enter an Ellerman container number');

    const url = new URL(endpoint);
    url.search = new URLSearchParams({ q: container, company_id: '5' }).toString();
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: {
            Accept: 'application/json', Origin: widget, Referer: widget + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'The Ellerman tracking widget refused the container search');
        return parseTracking(decodeText(bytes), container);
      },
    }]);
  },
});
