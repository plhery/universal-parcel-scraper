import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, RateLimitedError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { CTM_LOOKUP, CTM_MAX_BYTES, isCtmBlocked, normalizeCtmNumber, parseCtm, PROVIDER } from './parser.js';

export { CTM_LOOKUP, normalizeCtmNumber, parseCtm } from './parser.js';

const SITE = 'https://ctm-messagerie.ma';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class CtmTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The form post of the tracking page. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(CTM_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded', Origin: SITE, Referer: CTM_LOOKUP,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ ndesuivi: number }).toString() }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CTM_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 429, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 429) throw new RateLimitedError(PROVIDER);
    if (status === 401 || status === 403 || status === 503) {
      if (isCtmBlocked(body)) throw new ChallengeError(PROVIDER, 'CTM Messagerie answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'CTM Messagerie refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The page answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'CTM Messagerie tracking is unavailable', { status });
    return parseCtm(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCtmNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: CTM's receipt numbers are bare digits many carriers share, so no detection
// rule offers it and preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CtmTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
