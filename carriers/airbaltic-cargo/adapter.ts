import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.replace(/[\s-]+/g, '');
    const prefix = number.slice(0, 3);
    const serial = number.slice(3);
    if (!/^657\d{8}$/.test(number) || Number(serial.slice(0, 7)) % 7 !== Number(serial[7])) {
      throw new InvalidInputError(provider, 'Enter a valid airBaltic air waybill beginning with 657');
    }
    const url = new URL('https://cargotrack.airbaltic.com/');
    url.search = new URLSearchParams({ p: prefix, s: serial }).toString();
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(url.href, {
          headers: { Accept: 'text/html', Referer: 'https://www.airbaltic.com/en/cargo', 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 900_000, allowHttpStatuses: [403] });
        if (response.status === 403) throw new ChallengeError(provider, 'airBaltic refused the cargo lookup');
        return parseTracking(decodeText(bytes), prefix, serial);
      },
    }]);
  },
});
