import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { gollogWaybill, parseGollogReply, PROVIDER } from './parser.js';

const ORIGIN = 'https://servicos.gollog.com.br';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];

export const adapter: AdapterFactory = environment => ({
  id: 'gollog',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = gollogWaybill(input.number);
    const url = new URL('/api/services/app/Tracking/GetAllByCodes', ORIGIN);
    url.searchParams.set('values', number);
    return runSteps({ carrier: 'gollog', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url.toString(), {
          signal, headers: { Accept: 'application/json', 'Accept-Language': 'pt-BR',
            Referer: `${ORIGIN}/app/site/tracking`, 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 600_000,
          redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses: UNAVAILABLE });
        signal.throwIfAborted();
        if (response.status !== 200) throw new TransportError(PROVIDER, 'GOLLOG tracking endpoint is unavailable', { status: response.status });
        return parseGollogReply(decodeText(bytes), number);
      },
    }]);
  },
});
