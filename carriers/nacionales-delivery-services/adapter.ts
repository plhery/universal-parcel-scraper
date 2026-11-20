import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const portal = 'https://nacionalesdeliveryservices.com/rastreo';
const endpoint = 'https://api.nexgo.delivery/api/public/shipments/track/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^NX-?(\d{4})-?(\d{7})$/, 'NX-$1-$2');
    if (!/^[A-Z0-9][A-Z0-9-]{4,39}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Nacionales Delivery Services tracking number');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + encodeURIComponent(number), {
          signal, headers: { Accept: 'application/json', Referer: portal, 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 400_000, allowHttpStatuses: [403, 404],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'Nacionales Delivery Services requires verification');
        }
        if (response.status === 404) throw new NotFoundError(provider);
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Nacionales Delivery Services returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
