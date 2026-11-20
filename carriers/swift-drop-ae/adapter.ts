import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'swift-drop-ae';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const suffix = /^SD-?([A-Z0-9]{3,38})$/.exec(input.number.trim().toUpperCase())?.[1];
    if (!suffix) {
      throw new InvalidInputError(carrier, 'Swift Drop requires the full SD- order number');
    }

    const number = 'SD-' + suffix;
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded('https://swiftdrop.ae/track/' + encodeURIComponent(number), {
          signal,
          headers: { Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs,
          maxBytes: 512 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
