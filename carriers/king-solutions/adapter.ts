import type { AdapterFactory } from '../../core/adapter/index.js';
import { InvalidInputError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseReply, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'king-solutions', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    context.signal?.throwIfAborted();
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Invalid tracking number');
    return runSteps({ carrier: 'king-solutions', budgetMs: context.budgetMs ?? 15_000,
      signal: context.signal, recorder: environment.recorder }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { response, bytes } = await fetchBounded(`https://webapps.kingsolutionsglobal.com/KingREST/track/?pros=${number}`, {
        signal, headers: { 'User-Agent': userAgentOf(environment.userAgent), Accept: 'application/json' },
      }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: 512_000, allowHttpStatuses: [404, 410], fetcher: environment.fetcher });
      if (!response.ok) throw new TransportError(PROVIDER, `Tracking endpoint returned HTTP ${response.status}`);
      return parseReply(decodeText(bytes), number);
    } }]);
  },
});
