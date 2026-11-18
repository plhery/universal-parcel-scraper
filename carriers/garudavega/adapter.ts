import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseReply, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'garudavega', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = input.number.trim().toUpperCase();
    if (!/^\d{11}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid tracking number');
    return runSteps({ carrier: 'garudavega', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`https://www.garudavega.com/track/${number}`, {
        signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'text/html' },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000, allowHttpStatuses: [404, 410], fetcher: environment.fetcher });
      if (!response.ok) throw new TransportError(PROVIDER, `Tracking endpoint returned HTTP ${response.status}`);
      return parseReply(decodeText(bytes), number);
    } }]);
  },
});
