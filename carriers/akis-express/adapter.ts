import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeNumber, parseTracking, PROVIDER } from './parser.js';

export const adapter: AdapterFactory = environment => ({
  id: 'akis-express',
  recordsSteps: true,
  steps: ['direct'],
  track: (input, context = {}) => {
    context.signal?.throwIfAborted();
    const number = normalizeNumber(input.number);
    return runSteps({
      carrier: 'akis-express', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: environment.recorder ?? NOOP_RECORDER,
    }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { bytes } = await fetchBounded('https://gapakisexpress.com/wp-admin/admin-ajax.php', {
        method: 'POST', signal,
        headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent),
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({ action: 'tracking_show_table', tracking_num: number }),
      }, {
        provider: PROVIDER, fetcher: environment.fetcher, maxBytes: 500_000,
        timeoutMs: Math.max(1, Math.floor(remainingMs)),
      }).catch((error: unknown) => {
        signal.throwIfAborted();
        if (error instanceof UpstreamHttpError && error.kind === 'not_found') {
          throw new TransportError(PROVIDER, 'The carrier tracking endpoint is unavailable', { status: error.status });
        }
        throw error;
      });
      signal.throwIfAborted();
      const body = decodeText(bytes);
      return parseTracking(body, number);
    } }]);
  },
});
