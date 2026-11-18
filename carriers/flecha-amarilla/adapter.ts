import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { FLECHA_AMARILLA_MAX_BYTES, FLECHA_AMARILLA_URL, normalizeFlechaNumber, parseFlechaReply, PROVIDER } from './parser.js';

// The key the tracking page's script sends for every visitor.
const PAGE_KEY = 'U2FsdGVkX1/BTBLfbiHkha7QKFwZcwxtfiSe6utjkTxOdcfSK+E4k+LCqIyHszMXtbsmOtwelQQquFbjwTHWmduKGAB9pMbaFejhE2pqY9M='; // gitleaks:allow
const SITE = 'https://www.paqueteria-flechaamarilla.com.mx';

export class FlechaAmarillaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const guia = normalizeFlechaNumber(raw);
    return runSteps({ carrier: 'flecha-amarilla', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      const { bytes } = await fetchBounded(FLECHA_AMARILLA_URL, { signal, method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: PAGE_KEY,
          Origin: SITE, Referer: `${SITE}/`, 'User-Agent': userAgentOf(this.options.userAgent) },
        // The page's form sends a list of guías, each with the prefix and the digits apart.
        body: JSON.stringify([{ indice: '0', prefijo: guia.prefix, numeroGuia: guia.number }]) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: FLECHA_AMARILLA_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher,
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      return parseFlechaReply(decodeText(bytes), raw);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new FlechaAmarillaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'flecha-amarilla', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
