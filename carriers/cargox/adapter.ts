import type { AdapterFactory } from '../../core/adapter/index.js';
import { CarrierError, TransportError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeCargoXNumber, parseCargoX, PROVIDER } from './parser.js';

const LOOKUP = 'https://t.cargox.com.tr/getlink.php';
const ORIGIN = new URL(LOOKUP).origin;

function resultUrl(location: string | null): URL {
  let target: URL | undefined;
  try {
    if (location) target = new URL(location, LOOKUP);
  } catch {
    // A malformed redirect is handled like any other unexpected destination.
  }
  if (!target || target.origin !== ORIGIN || target.username || target.password || target.search || target.hash
    || !/^\/[A-Za-z0-9_-]{6,80}$/.test(target.pathname)) {
    throw new TransportError(PROVIDER, 'Cargo X redirected away from its shipment page');
  }
  return target;
}

export const adapter: AdapterFactory = environment => ({
  id: 'cargox', recordsSteps: true, steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeCargoXNumber(input.number);
    return runSteps({ carrier: 'cargox', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: environment.recorder }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const request = (url: string | URL, timeoutMs: number, allowHttpStatuses: number[]) =>
          fetchBounded(url, { signal, headers: { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) } }, {
            provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: 512_000,
            redirect: 'manual', fetcher: environment.fetcher, allowHttpStatuses,
          }).catch((error: unknown) => { signal.throwIfAborted(); throw error; });
        const entry = await request(`${LOOKUP}?${new URLSearchParams({ barcode: number })}`, remainingMs, [302]);
        signal.throwIfAborted();
        if (entry.response.status !== 302) return parseCargoX(decodeText(entry.bytes), number, entry.response.status);
        const target = resultUrl(entry.response.headers.get('location'));
        const page = await request(target, deadline - performance.now(), [404]).catch((error: unknown) => {
          // The redirect path is a shipment link. Keep it out of diagnostics.
          if (error instanceof CarrierError) {
            throw new CarrierError(error.kind, PROVIDER, 'Cargo X could not load its shipment page', {
              status: error.status, retryAfterMs: error.retryAfterMs,
            });
          }
          throw error;
        });
        signal.throwIfAborted();
        return parseCargoX(decodeText(page.bytes), number, page.response.status);
      },
    }]);
  },
});
