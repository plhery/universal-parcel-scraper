import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'bss-express-direct';
const origin = 'https://www.bssexpressdirect.com';
const tracker = origin + '/track';
const endpoint = origin + '/_serverFn/6206f963125aa3e4eb139a88e231afbd092ac45cc1ec0a9b86521450eb0cc7f6';

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase().replace(/^BSSRC(\d{5})$/, 'BSS-RC-$1');
    if (!/^[A-Z0-9-]{1,48}$/.test(number) || !/\d/.test(number)) {
      throw new InvalidInputError(carrier, 'BSS requires the tracking reference from the pickup receipt');
    }
    const url = new URL(endpoint);
    url.searchParams.set('payload', JSON.stringify({
      t: { t: 10, i: 0, o: 0, p: { k: ['data'], v: [{ t: 1, s: number }] } },
      f: 127, m: [],
    }));
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, {
          signal, headers: {
            Accept: 'application/json', Referer: tracker, 'User-Agent': userAgentOf(environment.userAgent),
            'X-TSR-ServerFn': 'true',
          },
        }, {
          provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024, redirect: 'error',
        });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
