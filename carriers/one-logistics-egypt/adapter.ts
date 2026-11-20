import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://onelogisticseg.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().replace(/^Freight(?=\/\d{4}\/\d+$)/i, 'Freight');
    if (!/^[\p{L}\d][\p{L}\d/._ -]{3,58}[\p{L}\d]$/u.test(number)) {
      throw new InvalidInputError(provider, 'Enter a ONE Logistics freight reference');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/wp-json/one-logistics/v1/track', {
          method: 'POST', signal, headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: origin + '/ar/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ tracking_ref: number }),
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 270_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl/i.test(body)) {
          throw new ChallengeError(provider, 'ONE Logistics requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'ONE Logistics returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
