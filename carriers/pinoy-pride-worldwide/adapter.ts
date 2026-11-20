import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://pinoyprideworldwidellc.com';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const invoice = input.number.trim().toUpperCase().replace(
      /^PPW([A-Z]{2})(RR)?(\d+)$/,
      (_, branch: string, service: string | undefined, serial: string) =>
        ['PPW', branch, ...(service ? [service] : []), serial].join('-'),
    );
    if (!/^[A-Z0-9-]{5,35}$/.test(invoice)) {
      throw new InvalidInputError(provider, 'Enter a Pinoy Pride Worldwide invoice number');
    }
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(origin + '/api/track/' + encodeURIComponent(invoice), {
          signal, headers: { Accept: 'application/json', Referer: origin + '/tracking', 'User-Agent': userAgentOf(environment.userAgent) },
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 300_000, allowHttpStatuses: [403, 404],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Pinoy Pride Worldwide refused the public invoice lookup');
        return parseTracking(decodeText(bytes), invoice, response.status);
      },
    }]);
  },
});
