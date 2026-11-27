import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeTmwNumber, parseTmwReply, PROVIDER, TMW_MAX_BYTES } from './parser.js';

export { normalizeTmwNumber, parseTmw, parseTmwReply, withoutContacts } from './parser.js';

/** The lookup the tracker on tmw-express.com.au and the label's page post an order number to. */
export const TMW_LOOKUP = 'https://www.tmw-express.com.au/qt/order/searchAirStep';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class TmwExpressTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(TMW_LOOKUP, { method: 'POST', signal,
      body: new URLSearchParams({ docnewcode: number }).toString(), headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TMW_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] })
      // A request the caller cancelled ends with the caller's reason.
      .catch((error: unknown) => { signal.throwIfAborted(); throw error; });
    signal.throwIfAborted();
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'TMW Express refused its guest lookup', { status: response.status });
    // An unknown order is HTTP 200 too; a redirect or a 404 is a moved route.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'TMW Express tracking lookup moved', { status: response.status });
    return parseTmwReply(decodeText(bytes).trim(), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeTmwNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new TmwExpressTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
