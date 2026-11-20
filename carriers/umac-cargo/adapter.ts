import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://umac-track.vercel.app';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9]{6,24}$/.test(number)) throw new InvalidInputError(provider, 'Enter a UMAC box number');
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 16_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/api/track', {
          method: 'POST', signal,
          headers: {
            Accept: 'application/json', 'Content-Type': 'application/json',
            Origin: origin, Referer: origin + '/', 'User-Agent': userAgentOf(environment.userAgent),
          },
          body: JSON.stringify({ trackingNo: number }),
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 350_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'UMAC refused the public box lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
