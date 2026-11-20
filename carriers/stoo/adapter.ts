import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://stline.stload.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,40}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter the STOO reception number');
    }
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/api/external/tracking/' + encodeURIComponent(number), {
          signal, headers: {
            Accept: 'application/json', Referer: origin + '/tracking', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 300_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl/i.test(body)) {
          throw new ChallengeError(provider, 'STOO requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'STOO returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
