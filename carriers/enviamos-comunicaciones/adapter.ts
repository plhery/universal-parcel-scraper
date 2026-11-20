import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const search = 'https://www.enviamoscym.com/rastreo-envios-mensajeria.php';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Za-z0-9-]{1,70}$/.test(number)) {
      throw new InvalidInputError(provider, 'Enter the main guide code from the Enviamos label');
    }
    const query = new URLSearchParams({ codigo: number, 'tipo-codigo': 'cod-principal' });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(search + '?' + query.toString(), {
          headers: { Accept: 'text/html', Referer: search, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 600_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'Enviamos refused the guest lookup');
        return parseTracking(decodeText(bytes), number);
      },
    }]);
  },
});
