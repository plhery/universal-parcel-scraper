import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'thai-nexus';
const origin = 'https://tracking.thainexus.co.th';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^SRFW(\d{6})(\d)$/, 'SR-FW-$1-$2');
    if (!/^[A-Z0-9-]{1,48}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'Thai Nexus requires the tracking number from the dispatch confirmation');
    }
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(origin + '/track/' + encodeURIComponent(number), {
          signal, headers: {
            Accept: 'text/html', 'Accept-Language': 'en', 'User-Agent': userAgentOf(environment.userAgent),
          },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 1024 * 1024,
          redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
