import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  CORREOS_ECUADOR_MAX_BYTES, CORREOS_ECUADOR_ORIGIN, CORREOS_ECUADOR_TRACKING, correosEcuadorFormFields, isCorreosEcuadorBlocked,
  normalizeCorreosEcuadorNumber, parseCorreosEcuador, PROVIDER,
} from './parser.js';

export { CORREOS_ECUADOR_TRACKING } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 20_000;

export class CorreosEcuadorTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCorreosEcuadorNumber(raw);
    // One attempt opens the tracking page and posts the code back with the
    // form's state, as its Consultar button does. The reCAPTCHA field goes
    // empty, which the tracker accepts; no cookie is needed.
    const attempt = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      // A request left without time fails as a timeout, which the retry can recover.
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const headers = { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-EC,es;q=0.9', 'User-Agent': userAgentOf(this.options.userAgent) };
      const read = async (init: RequestInit): Promise<string> => {
        const { response, bytes } = await fetchBounded(CORREOS_ECUADOR_TRACKING, { ...init, signal }, { provider: PROVIDER, timeoutMs: left(),
          maxBytes: CORREOS_ECUADOR_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
          allowHttpStatuses: [...REDIRECTS, 403, 404, 410, 503] });
        const html = decodeText(bytes);
        if (response.status === 403 || response.status === 503) {
          if (isCorreosEcuadorBlocked(html)) throw new ChallengeError(PROVIDER, 'Servicios Postales del Ecuador answered with a block page', { status: response.status });
          if (response.status === 403) throw new ChallengeError(PROVIDER, 'Servicios Postales del Ecuador refused the lookup', { status: 403 });
        }
        // The tracker answers the page and every search with HTTP 200; a redirect or a 404 is a moved route.
        if (response.status !== 200) throw new TransportError(PROVIDER, 'Servicios Postales del Ecuador tracking is unavailable', { status: response.status });
        return html;
      };
      const fields = correosEcuadorFormFields(await read({ method: 'GET', headers }), number);
      const answer = await read({ method: 'POST', body: fields.toString(), headers: { ...headers,
        'Content-Type': 'application/x-www-form-urlencoded', Origin: CORREOS_ECUADOR_ORIGIN, Referer: CORREOS_ECUADOR_TRACKING } });
      return parseCorreosEcuador(answer, number);
    };
    // An attempt that fails to reach the tracker, or hangs, gets one more: the
    // first gets half of the budget, so the retry fits in the rest. An HTTP
    // status, a rate limit included, is never sent again.
    return runSteps({ carrier: 'correos-ecuador', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => attempt(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => attempt(signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Servicios Postales del Ecuador for
// a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CorreosEcuadorTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'correos-ecuador', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
