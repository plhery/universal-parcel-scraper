import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking } from './parser.js';

const carrier = 'alhosary-shipping';
const tracker = 'https://alhosaryshipping.com/tracking';
const endpoint = new URL('https://alhosaryshipping.com/_serverFn/96f6a363d6ba669a00577269dd0b4e58c8e79a18873cb7718a783569f63f1262');

function lookupBody(number: string): string {
  // The guest form sends a Seroval object containing a single data field.
  return JSON.stringify({
    t: {
      t: 10, i: 0, o: 0,
      p: { k: ['data'], v: [{ t: 10, i: 1, o: 0, p: { k: ['tracking_number'], v: [{ t: 1, s: number }] } }] },
    },
    f: 127, m: [],
  });
}

export const adapter: AdapterFactory = (environment) => ({
  id: carrier, recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const match = /^AHS-?(\d{6})-?(\d{4})$/.exec(input.number.trim().toUpperCase());
    if (!match) throw new InvalidInputError(carrier, 'Alhosary requires a shipment number beginning with AHS');
    const number = ['AHS', match[1], match[2]].join('-');
    return runSteps({
      carrier, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(endpoint, {
          method: 'POST', signal, body: lookupBody(number),
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Referer: tracker,
            'User-Agent': userAgentOf(environment.userAgent),
            'X-TSR-ServerFn': 'true',
          },
        }, { provider: carrier, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 256 * 1024, redirect: 'error' });
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
