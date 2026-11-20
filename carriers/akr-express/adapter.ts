import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider, referencePattern } from './parser.js';

const lookupUrl = 'https://akrexpress.com/wp-admin/admin-ajax.php';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim().toUpperCase();
    if (!referencePattern.test(reference)) throw new InvalidInputError(provider, 'Enter an AKR Express lorry receipt number');
    return runSteps({
      carrier: provider, signal: context.signal, recorder: environment.recorder, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(lookupUrl, {
          method: 'POST', signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
          body: new URLSearchParams({ action: 'akr_lr_track', lr_number: reference }),
        }, { provider, timeoutMs: remainingMs, maxBytes: 256 * 1024, allowHttpStatuses: [403, 404], fetcher: environment.fetcher });
        const body = decodeText(bytes);
        if (response.status === 403 || (/^\s*</.test(body) && /_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)/i.test(body))) {
          throw new ChallengeError(provider, 'AKR Express blocked the public tracking request');
        }
        return parseTracking(parseJsonBytes(bytes, provider), response.status);
      },
    }]);
  },
});
