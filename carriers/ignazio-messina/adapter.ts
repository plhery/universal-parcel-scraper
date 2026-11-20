import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://wpsapps.messinaline.it';
const referer = `${origin}/MessinaApps/tracking2025/index.html`;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Messina container number');
    const url = new URL('/MessinaShippingAPI/v1/ExDomino/ContainerTracking', origin);
    url.search = new URLSearchParams({ booking: '', bl: '', cntr: number }).toString();

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'application/json', Referer: referer, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Messina refused the container lookup');
        return parseTracking(decodeText(bytes));
      },
    }]);
  },
});
