import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://tracking.cargolane.net';
const portal = origin + '/tracking/ShipmentInfo';
const endpoint = origin + '/stage-api/web/ebOrder/shipmentInfo';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const container = input.number.replace(/[\s-]+/g, '').toUpperCase();
    if (!/^[A-Z]{4}\d{7}$/.test(container)) throw new InvalidInputError(provider, 'Enter an Honour Lane container number');
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ seaOrAir: 'S', paramType: 'ctn_no', paramNo: container }).toString();
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 800_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'Honour Lane refused the cargo tracking request');
        return parseTracking(decodeText(bytes), container);
      },
    }]);
  },
});
