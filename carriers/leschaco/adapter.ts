import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://visible-api.leschaco.com/v1/Tracking/Anonymous/';
const portal = 'https://visible.leschaco.com/';

export const adapter: AdapterFactory = environment => ({
  id: provider, steps: ['direct'], recordsSteps: true,
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^ALRB[ -]+/, 'ALRB');
    if (!/^[A-Z0-9]{5,38}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter the Leschaco bill of lading or shipment reference');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + encodeURIComponent(number), {
          signal, headers: {
            Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 700_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
          throw new ChallengeError(provider, 'Leschaco requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Leschaco did not return shipment JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
