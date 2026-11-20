import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'mbg-africa';
const endpoint = 'https://mbg-africa.com/track.php';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const supplied = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,64}$/.test(supplied)) throw new InvalidInputError(carrier, 'Enter the MBG-Africa tracking number');
    const number = supplied.replace(/^MBG(\d{4})(\d{6})$/, 'MBG-$1-$2');
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ tn: number, lang: 'en' }).toString();

    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 512 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
