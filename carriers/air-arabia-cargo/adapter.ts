import type { AdapterFactory } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AIRLINES, normalizeWaybill, parseTracking, provider } from './parser.js';

const endpoint = 'https://airarabia-api.ibsplc.aero/icargo-api';
const page = 'https://cargo.airarabia.com/cargo-tracking/';
// The public tracking page sends this key with every visitor's lookup.
const API_KEY = 'MeEge0jZ9b8fuIWRKLcyk3jfhio1lu7S4rTmXPkp'; // gitleaks:allow

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const waybill = normalizeWaybill(input.number);

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const url = `${endpoint}/${AIRLINES[waybill.prefix]}/enterprise/v1/trackings/awbs/${waybill.prefix}-${waybill.serial}`;
        // The API answers an unknown waybill with HTTP 400 and its not-found code.
        const { bytes, response } = await fetchBounded(url, {
          signal,
          headers: {
            Accept: 'application/json', 'x-api-key': API_KEY, Origin: 'https://cargo.airarabia.com', Referer: page,
            'User-Agent': userAgentOf(environment.userAgent),
          },
        }, { provider, timeoutMs: remainingMs, fetcher: environment.fetcher, maxBytes: 600_000, allowHttpStatuses: [400] });
        return parseTracking(decodeText(bytes), response.status, waybill);
      },
    }]);
  },
});
