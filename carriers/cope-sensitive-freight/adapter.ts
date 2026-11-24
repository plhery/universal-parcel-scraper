import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COPE_ACTION, COPE_LOOKUP, COPE_MAX_BYTES, isCopeBlocked, normalizeCopeNumber, parseCope, PROVIDER } from './parser.js';

export { COPE_ACTION, COPE_LOOKUP, normalizeCopeNumber, parseCope } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class CopeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The post the tracking pop-up's script makes, as jQuery sends it. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(COPE_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': userAgentOf(this.options.userAgent), 'X-Requested-With': 'XMLHttpRequest',
    }, body: new URLSearchParams({ action: COPE_ACTION, consignment_code: number }).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COPE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 404, 410],
    });
    const text = decodeText(bytes);
    if (isCopeBlocked(text)) throw new ChallengeError(PROVIDER, 'COPE answered with a browser check', { status: response.status });
    // A redirect is a moved site or a login. WordPress answers an action no plugin registers
    // with HTTP 400 and `0`; a 404 is a moved route. None is a missing consignment.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'COPE tracking lookup is unavailable', { status: response.status });
    return parseCope(text, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCopeNumber(raw);
    // A read that fails to reach the site, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers COPE for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CopeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
