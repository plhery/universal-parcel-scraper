import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isViapostErrorPage, normalizeViapostNumber, parseViapost, PROVIDER, VIAPOST_MAX_BYTES, viapostTrackingUrl } from './parser.js';

export { normalizeViapostNumber, parseViapost, viapostTrackingUrl } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
// Server errors are read here: the tracker answers an order it does not know with HTTP 500.
const SERVER_ERRORS = Array.from({ length: 100 }, (_, index) => 500 + index);
const DEFAULT_BUDGET_MS = 15_000;

export class ViapostTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The order's page, rendered on the server, with no session, token or captcha.
    const { response, bytes } = await fetchBounded(viapostTrackingUrl(number), { signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: VIAPOST_MAX_BYTES, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, ...SERVER_ERRORS] });
    if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Viapost refused its guest request');
    if (response.status === 500) {
      // Only the site's generic error page answers an unknown order; any other server error is an outage.
      if (isViapostErrorPage(decodeText(bytes))) throw new NotFoundError(PROVIDER, 'Viapost has no order under this number');
      throw new TransportError(PROVIDER, 'Viapost failed to answer', { status: response.status });
    }
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Viapost tracking failed or moved', { status: response.status });
    return parseViapost(decodeText(bytes), number);
  }

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeViapostNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: 'viapost', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new ViapostTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'viapost', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};
