import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://ecom.tailwind-ahead.com';
const endpoint = 'https://tailwind-ecom-proxy.api.prod.sit.sys.odj.cloud/api/v2/tracking/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{4,25}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter a Tailwind bill of lading, booking or equipment number');
    }

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + encodeURIComponent(number), {
          signal,
          headers: {
            Accept: 'application/json', Origin: origin, Referer: origin + '/tracking',
            'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 650_000, allowHttpStatuses: [403],
        });
        const body = decodeText(bytes);
        if (response.status === 403 || /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
          throw new ChallengeError(provider, 'Tailwind Shipping Lines requires verification');
        }
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          throw new SchemaError(provider, 'Tailwind Shipping Lines returned invalid tracking JSON');
        }
        return parseTracking(data, number);
      },
    }]);
  },
});
