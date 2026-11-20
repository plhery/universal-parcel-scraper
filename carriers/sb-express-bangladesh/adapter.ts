import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.sbexpresslimited.com';
const endpoint = origin + '/api/track';

export const adapter: AdapterFactory = environment => ({
  id: provider, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^NET-?(\d+)$/, 'NET-$1');
    if (!/^[A-Z0-9][A-Z0-9-]{4,34}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter an SB Express tracking number');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint, {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json', Origin: origin,
            Referer: origin + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ tracking_number: number }),
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 370_000, allowHttpStatuses: [403, 404],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'SB Express requires verification');
        }
        if (response.status === 404) throw new NotFoundError(provider);
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'SB Express returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
