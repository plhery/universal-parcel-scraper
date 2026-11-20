import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().replace(/^631-/, '631');
    if (!/^631\d{8}$/.test(reference)) {
      throw new InvalidInputError(provider, 'Enter the eleven-digit Air Greenland air waybill beginning with 631');
    }
    const url = new URL('https://airgreenland.com/umbraco/api/Calculator/track');
    url.search = new URLSearchParams({ awbNumber: reference, cargoLanguageId: 'en', action: 'get' }).toString();
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal,
      budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url, {
          signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
        }, { provider, timeoutMs: remainingMs, maxBytes: 256 * 1024, fetcher: environment.fetcher });
        if (response.headers.get('cf-mitigated') === 'challenge'
          || /<title>\s*(?:Just a moment|Access denied|Verification required)/i.test(decodeText(bytes))) {
          throw new ChallengeError(provider, 'Air Greenland returned a browser verification page');
        }
        return parseTracking(parseJsonBytes(bytes, provider), reference);
      },
    }]);
  },
});
