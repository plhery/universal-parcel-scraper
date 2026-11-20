import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, referencePattern } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!referencePattern.test(reference)) throw new InvalidInputError(provider, 'Enter a Freight Club tracking reference');
    const url = new URL(`https://app.freightclub.com/Tracking/GetTrackingInfo/${reference}`);
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, redirect: 'error', headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider, timeoutMs: remainingMs, maxBytes: 512 * 1024, fetcher: environment.fetcher });
        const body = decodeText(bytes);
        if (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)/i.test(body)) {
          throw new ChallengeError(provider, 'Freight Club returned a browser verification page');
        }
        return parseTracking(parseJsonBytes(bytes, provider), reference);
      },
    }]);
  },
});
