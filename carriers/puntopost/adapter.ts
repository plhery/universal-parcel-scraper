import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isPuntopostAbsence, normalizePuntopostNumber, parsePuntopost, PROVIDER, PUNTOPOST_MAX_BYTES, puntopostUrl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// A challenge page Cloudflare, in front of the service, can send instead of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;

function json(bytes: Uint8Array): unknown {
  const body = decodeText(bytes);
  try {
    return JSON.parse(body);
  } catch (error) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PuntoPost answered with a browser challenge', { cause: error });
    throw new SchemaError(PROVIDER, 'PuntoPost returned a reply that is not JSON', { cause: error });
  }
}

export class PuntopostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizePuntopostNumber(raw), url = puntopostUrl(number);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        maxBytes: PUNTOPOST_MAX_BYTES, redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410] });
      signal.throwIfAborted();
      if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'PuntoPost redirected its tracking service', { status: response.status });
      if (response.status === 403) {
        if (CHALLENGE.test(decodeText(bytes).slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PuntoPost answered with a browser challenge', { status: 403 });
        throw new ChallengeError(PROVIDER, 'PuntoPost refused public tracking', { status: 403 });
      }
      if (response.status === 404) {
        // Only the service's own problem reply for a parcel means it has none; a bare 404 is a moved route.
        const body = (() => { try { return json(bytes); } catch { return null; } })();
        if (isPuntopostAbsence(body)) return parsePuntopost(body, number);
        throw new TransportError(PROVIDER, 'PuntoPost tracking service is unavailable', { status: 404 });
      }
      if (response.status === 410) throw new TransportError(PROVIDER, 'PuntoPost tracking service is gone', { status: 410 });
      // The normalized number always passes the service's check, so a refusal is a changed service.
      if (response.status === 400) throw new IndeterminateError(PROVIDER, 'PuntoPost refused the number it was sent', { status: 400 });
      return parsePuntopost(json(bytes), number);
    };
    // A request that fails to reach PuntoPost, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'puntopost', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new PuntopostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'puntopost', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
