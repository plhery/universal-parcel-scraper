import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { glsCanadaNumber, parseGlsCanada, PROVIDER } from './parser.js';

const ENDPOINT = 'https://web.gls-canada.com/api/tracking/';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];

export const adapter: AdapterFactory = environment => ({
  id: 'gls-ca',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = glsCanadaNumber(input.number);
    return runSteps({ carrier: 'gls-ca', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(`${ENDPOINT}${number}`, {
          signal,
          headers: { Accept: 'application/json', 'Accept-Language': 'en-CA',
            Origin: 'https://gls-group.com', Referer: 'https://gls-group.com/',
            'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 700_000,
          redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses: UNAVAILABLE });
        signal.throwIfAborted();
        if (response.status !== 200) throw new TransportError(PROVIDER, 'GLS Canada tracking endpoint is unavailable', { status: response.status });
        return parseGlsCanada(decodeText(bytes), number);
      },
    }]);
  },
});
