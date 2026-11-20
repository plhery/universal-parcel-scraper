import type { AdapterFactory } from '../../core/adapter/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeNumber, parseTracking, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'sway',
  recordsSteps: true,
  steps: ['direct'],
  track: (input, context = {}) => {
    context.signal?.throwIfAborted();
    const number = normalizeNumber(input.number);
    return runSteps({
      carrier: 'sway', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: environment.recorder ?? NOOP_RECORDER,
    }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const url = new URL(`https://track.shipsway.com/api/tracking/${encodeURIComponent(number)}`);
      const { response, bytes } = await fetchBounded(url, {
        signal, headers: { Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent) },
      }, {
        provider: PROVIDER, fetcher: environment.fetcher, maxBytes: 500_000, allowHttpStatuses: [404, 410],
        timeoutMs: Math.max(1, Math.floor(remainingMs)),
      });
      signal.throwIfAborted();
      const body = decodeText(bytes);
      return parseTracking(response.status, body, number);
    } }]);
  },
});
