import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://neptunebermuda.com';
const portal = origin + '/track-shipment/';
const endpoint = origin + '/wp-json/bcl-tracker/v1/search';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  steps: ['direct'],
  recordsSteps: true,
  async track(input, context = {}) {
    const number = input.number.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{5,35}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Bermuda Container Line booking or container number');
    }

    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST', signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
          body: JSON.stringify({ query: number }),
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 550_000, allowHttpStatuses: [403] });
        const body = decodeText(bytes);
        if (response.status === 403 || /cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
          throw new ChallengeError(provider, 'Bermuda Container Line requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Bermuda Container Line returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
