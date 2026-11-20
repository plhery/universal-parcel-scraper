import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://www.vidhitransport.com/lr-track.html';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^\d{3,24}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Vidhi lorry receipt number');
    const endpoint = new URL('https://vidhierp.in/service.aspx');
    // These literal site identifiers appear on the guest form, which sends no credentials.
    endpoint.search = new URLSearchParams({
      ApiVer: '1', DeviceId: 'KRISH_ID', AppId: 'V01', Lat: '0', Lng: '0',
      Control: 'getLRWebsite', data: JSON.stringify({ lrno: number }),
    }).toString();

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint.href, {
          headers: {
            Accept: 'application/json', Origin: new URL(portal).origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 90_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Vidhi refused the lorry receipt search');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
