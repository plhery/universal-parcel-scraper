import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://vip.translinkshipping.com';
const trackingUrl = origin + '/Pages/CargoTracking.aspx';
const endpoint = origin + '/AjaxCT/CargoTracking.cspx';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = /^(?:TLKP[ -]?)?([A-Z0-9]{8,18})$/i.exec(input.number.trim())?.[1]?.toUpperCase();
    if (!number) throw new InvalidInputError(provider, 'Enter a Translink house bill of lading number');
    const url = new URL(endpoint);
    url.searchParams.set('HBLNO', number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: {
            Accept: 'text/html', Referer: trackingUrl, 'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': userAgentOf(environment.userAgent),
          },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 400_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Translink refused the cargo tracking request');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
