import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'bja-logistic';
const origin = 'https://bjalogistic.id';

export const adapter: AdapterFactory = environment => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const reference = input.number.trim();
    if (!/^\d{1,24}$/.test(reference)) throw new InvalidInputError(carrier, 'Enter the numeric BJA No.');
    const number = reference.replace(/^0+(?=\d)/, '');
    const url = new URL('/api/tracking', origin);
    url.searchParams.set('resi', number);
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 12_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url, {
          signal, headers: { Accept: 'application/json', Referer: origin + '/cek-resi', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 256 * 1024, redirect: 'error', allowHttpStatuses: [404],
        });
        return parseTracking(decodeText(bytes), response.status, number);
      },
    }]);
  },
});
