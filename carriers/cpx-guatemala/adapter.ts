import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'cpx-guatemala';
const origin = 'https://tracking.cpxbox.com';

export const adapter: AdapterFactory = environment => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    let number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,60}$/.test(number)) throw new InvalidInputError(carrier, 'Enter a CPX tracking reference');
    const compact = /^(FGUA\d{6})(\d{5})(\d)$/.exec(number);
    if (compact) number = `${compact[1]}-${compact[2]}-${compact[3]}`;
    const url = origin + '/api/tracking/' + encodeURIComponent(number);
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, headers: { Accept: 'application/json', Referer: origin + '/', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 384 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
