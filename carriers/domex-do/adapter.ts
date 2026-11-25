import type { AdapterFactory } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { domexGuide, parseDomex, PROVIDER, TRACKING_URL } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'domex-do', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const guide = domexGuide(input.number);
    const url = `${TRACKING_URL}?${new URLSearchParams({ id: guide })}`;
    return runSteps({ carrier: 'domex-do', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const { bytes } = await fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) } }, {
          provider: PROVIDER, timeoutMs: Math.floor(remainingMs), maxBytes: 512_000, redirect: 'manual', fetcher: environment.fetcher,
        }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        signal.throwIfAborted();
        return parseDomex(decodeText(bytes), guide);
      },
    }]);
  },
});
