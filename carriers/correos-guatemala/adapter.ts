import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CORREOS_GUATEMALA_PAGE, normalizeCorreosGuatemalaNumber, parseCorreosGuatemala, PROVIDER } from './parser.js';

export { parseCorreosGuatemala } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];

export class CorreosGuatemalaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeCorreosGuatemalaNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The tracker's form, one item code, with no session, captcha or account.
      const { response, bytes } = await fetchBounded(CORREOS_GUATEMALA_PAGE, { method: 'POST', signal, body: new URLSearchParams({ tracking: number }).toString(),
        headers: { Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Correos de Guatemala refused its guest request');
      // An unknown item is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Correos de Guatemala tracking page moved', { status: response.status });
      return parseCorreosGuatemala(decodeText(bytes), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'correos-guatemala', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new CorreosGuatemalaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'correos-guatemala', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
