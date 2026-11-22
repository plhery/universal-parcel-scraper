import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { LEDA_MAX_BYTES, LEDA_PAGE, normalizeLedaNumber, parseLeda, PROVIDER } from './parser.js';

export { normalizeLedaNumber, parseLeda } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class LedaTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The form the site's tracking page posts, one number, with no session, captcha or account. The
    // site answers over HTTP only: its HTTPS port does not answer.
    const { response, bytes } = await fetchBounded(LEDA_PAGE, { method: 'POST', signal, body: new URLSearchParams({ express: number }).toString(),
      headers: { Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', Referer: LEDA_PAGE,
        'User-Agent': userAgentOf(this.options.userAgent) } },
    { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: LEDA_MAX_BYTES, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Leda Express refused its guest request');
    // An unknown number is HTTP 200 too; anything else is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Leda Express tracking page moved', { status: response.status });
    return parseLeda(decodeText(bytes), number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeLedaNumber(raw);
    // A request that fails to reach the server, or hangs, gets one more try in the rest of the budget.
    return runSteps({ carrier: 'leda-express', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new LedaTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'leda-express', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
