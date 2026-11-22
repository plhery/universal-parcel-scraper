import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CAUTCURIER_ENDPOINT, isCautCurierNotFound, normalizeCautCurierNumber, parseCautCurier, PROVIDER } from './parser.js';

export { isCautCurierNotFound, normalizeCautCurierNumber, parseCautCurier } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|verify (?:that )?you are human/i;

export class CautCurierTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCautCurierNumber(raw);
    const url = `${CAUTCURIER_ENDPOINT}?${new URLSearchParams({ awb: number })}`;
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The lookup the tracking page calls, with no session, token or account.
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal,
        headers: { Accept: 'application/json, text/plain, */*', Origin: 'https://tracking.cautcurier.ro', Referer: 'https://tracking.cautcurier.ro/',
          'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 512 * 1024, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 500] });
      signal.throwIfAborted();
      const body = decodeText(bytes).replace(/^\uFEFF/, '');
      if ([401, 403].includes(response.status) || response.headers.get('cf-mitigated') === 'challenge' || CHALLENGE.test(body.slice(0, 64_000))) {
        throw new ChallengeError(PROVIDER, 'CautCurier answered with a browser check');
      }
      if (response.status !== 200 && response.status !== 500) throw new TransportError(PROVIDER, 'CautCurier tracking lookup moved', { status: response.status });
      let payload: unknown;
      try { payload = JSON.parse(body); } catch {
        if (response.status === 500) throw new IndeterminateError(PROVIDER, 'CautCurier failed without its not-found reply');
        throw new SchemaError(PROVIDER, 'CautCurier returned a reply that is not JSON');
      }
      // The server answers an AWB it has no order for with an HTTP 500 and one exact message; any
      // other 500 is a fault, not an absence.
      if (response.status === 500) {
        if (isCautCurierNotFound(payload)) throw new NotFoundError(PROVIDER);
        throw new IndeterminateError(PROVIDER, 'CautCurier failed without its not-found reply');
      }
      return parseCautCurier(payload, number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'cautcurier', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CautCurierTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'cautcurier', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
