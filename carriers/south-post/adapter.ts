import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeSouthPostNumber, parseSouthPostReply, PROVIDER, SOUTH_POST_MAX_BYTES, SOUTH_POST_URL } from './parser.js';

export class SouthPostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeSouthPostNumber(raw);
    return runSteps({ carrier: 'south-post', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [{ id: 'direct', run: async ({ signal, remainingMs }) => {
      // The page's script posts the number as JSON, without a session or a key.
      const { response, bytes } = await fetchBounded(SOUTH_POST_URL, { signal, method: 'POST',
        headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent) },
        body: JSON.stringify({ nro_guia: number }) }, {
        provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(remainingMs)), maxBytes: SOUTH_POST_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [404, 410],
      }).catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      // An unknown number answers HTTP 500; a missing address means the service moved.
      if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, `South Post's tracker answered HTTP ${response.status}`);
      return parseSouthPostReply(decodeText(bytes), number);
    } }]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new SouthPostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'south-post', recordsSteps: true, steps: ['direct'], track: (input, context) => tracker.fetch(input.number, context) };
};
