import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { fetchTrusting } from '../../core/transport/https.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { DIGICERT_GLOBAL_G2_CA1 } from './certificate.js';
import { normalizeNumber, parseTracking, PROVIDER } from './parser.js';

let trusting: typeof fetch | undefined;
const trustingFetch = () => trusting ??= fetchTrusting([DIGICERT_GLOBAL_G2_CA1]);

export const adapter: AdapterFactory = environment => ({
  id: 'diakinisis',
  recordsSteps: true,
  steps: ['direct'],
  track: (input, context = {}) => {
    context.signal?.throwIfAborted();
    const number = normalizeNumber(input.number);
    return runSteps({
      carrier: 'diakinisis', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: environment.recorder ?? NOOP_RECORDER,
    }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const fetcher = transportOf(environment.fetcher) === undefined ? trustingFetch() : environment.fetcher;
      const { bytes } = await fetchBounded('https://pod.diakinisis.gr/server_handler_ext.php', {
        method: 'POST', signal,
        headers: {
          Accept: 'application/json', 'User-Agent': userAgentOf(environment.userAgent),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        },
        body: new URLSearchParams({
          cmd: 'srvcmd_ext_tnt', action: 'srvaction_getrecordstatus', trackingId: number, secondId: '', agreementId: '0',
        }),
      }, {
        provider: PROVIDER, fetcher, maxBytes: 500_000,
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
