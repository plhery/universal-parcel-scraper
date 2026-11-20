import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://globalexpress.co.tz';
const endpoint = origin + '/api/track/';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^GEL-?(\d{4})-?(\d{6})$/, 'GEL-$1-$2');
    if (!/^[A-Z0-9][A-Z0-9-]{4,39}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Global Express Logistics tracking number');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + encodeURIComponent(number), {
          signal, headers: {
            Accept: 'application/json', Referer: origin + '/tracking', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 460_000, allowHttpStatuses: [403, 404],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'Global Express Logistics Tanzania requires verification');
        }
        if (response.status === 404) throw new NotFoundError(provider);
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Global Express Logistics Tanzania returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
