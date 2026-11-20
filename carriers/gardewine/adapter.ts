import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const route = 'https://gardewineweb.gardewine.com/scripts/cgiip.exe/';
const portal = `${route}main-frame.htm?language=ENGLISH&nav=top`;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{6,12}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Gardewine shipment number');
    const url = new URL('boldetail.htm', route);
    url.search = new URLSearchParams({ language: 'ENGLISH', nav: 'top', wbtn: 'PRO', wpro1: number }).toString();

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'text/html', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) }, signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 250_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Gardewine refused the shipment lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
