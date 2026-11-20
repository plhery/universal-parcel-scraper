import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const endpoint = 'https://silogcotaxierp.serviciosproductivos.com.co/operacion_transporte/rep.guia_web.php';
const search = 'https://www.cotaxi.com.co/';

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const match = /^([A-Z]{1,10})[ -]?(\d{1,15})$/.exec(input.number.trim().toUpperCase());
    const prefix = match?.[1];
    const serial = match?.[2];
    if (!prefix || !serial) throw new InvalidInputError(provider, 'Enter the COTAXI guide prefix and number');
    const query = new URLSearchParams({ txtPrefijoGuia: prefix, txtNroGuia: serial });
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes, response } = await fetchBounded(endpoint + '?' + query.toString(), {
          headers: { Accept: 'application/pdf, text/html', Referer: search, 'User-Agent': userAgentOf(environment.userAgent) },
          signal,
        }, {
          provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 500_000, allowHttpStatuses: [403],
        });
        if (response.status === 403) throw new ChallengeError(provider, 'COTAXI refused the guest lookup');
        return parseTracking(bytes, prefix + '-' + serial);
      },
    }]);
  },
});
