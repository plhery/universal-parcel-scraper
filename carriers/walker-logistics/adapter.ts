import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseWalkerLogistics, PROVIDER } from './parser.js';

const API = 'https://walkerlogistics.tempo.delivery/trackerapi/api/v1/consignment/';

export const adapter: AdapterFactory = environment => ({
  id: 'walker-logistics',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = input.number.trim();
    if (!/^[A-Z0-9-]{4,64}$/i.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid consignment number');
    return runSteps({ carrier: 'walker-logistics', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { bytes } = await fetchBounded(API + encodeURIComponent(number), {
        signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000, fetcher: environment.fetcher });
      const body = decodeText(bytes);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch (cause) {
        if (/<title>\s*Just a moment|_cf_chl_opt|AwsWafIntegration/i.test(body.slice(0, 64_000))) {
          throw new ChallengeError(PROVIDER, 'Walker Logistics returned a browser check', { cause });
        }
        throw new SchemaError(PROVIDER, 'Walker Logistics returned invalid JSON', { cause });
      }
      return parseWalkerLogistics(payload, number);
    } }]);
  },
});
