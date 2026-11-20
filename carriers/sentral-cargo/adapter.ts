import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseSentralTracking, PROVIDER, sentralReceiptNumber } from './parser.js';

const ORIGIN = 'https://sentralcargo.co.id';
const UNAVAILABLE = [301, 302, 303, 307, 308, 404, 410];

export const adapter: AdapterFactory = environment => ({
  id: 'sentral-cargo',
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = sentralReceiptNumber(input.number);
    const url = new URL('/cekresi', ORIGIN);
    url.searchParams.set('resi', number);
    return runSteps({ carrier: 'sentral-cargo', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { response, bytes } = await fetchBounded(url.toString(), {
          signal, headers: { Accept: 'text/html', 'Accept-Language': 'id', 'User-Agent': userAgentOf(environment.userAgent) },
        }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 650_000,
          redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses: UNAVAILABLE });
        signal.throwIfAborted();
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Sentral Cargo tracking page is unavailable', { status: response.status });
        return parseSentralTracking(decodeText(bytes), number);
      },
    }]);
  },
});
