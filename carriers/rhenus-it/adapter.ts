import type { Pool } from 'undici';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { normalizeNumber, parseTracking, PROVIDER } from './parser.js';

const ORIGIN = 'https://tracking.rhenusitalia.it';
let defaultPool: Promise<Pool> | undefined;

function rhenusPool(): Promise<Pool> {
  // The server offers undersized finite-field DH before a working TLS 1.2 suite.
  return defaultPool ??= import('undici').then(({ Pool }) => new Pool(ORIGIN, { connect: { ciphers: 'DEFAULT:!DHE' } }));
}

export const adapter: AdapterFactory = environment => ({
  id: 'rhenus-it',
  recordsSteps: true,
  steps: ['direct'],
  track: (input, context = {}) => {
    context.signal?.throwIfAborted();
    const number = normalizeNumber(input.number);
    return runSteps({
      carrier: 'rhenus-it', signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
      recorder: environment.recorder ?? NOOP_RECORDER,
    }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const dispatcher = transportOf(environment.fetcher) === undefined ? await rhenusPool() : undefined;
      signal.throwIfAborted();
      const url = new URL('/rhenus/tracking.jsf', ORIGIN);
      url.searchParams.set('s', number);
      const { bytes } = await fetchBounded(url, {
        signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) },
        ...(dispatcher ? { dispatcher } : {}),
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
