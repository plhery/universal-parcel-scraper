import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { KARGOLIFE_MAX_BYTES, normalizeKargolifeNumber, parseKargolife, PROVIDER } from './parser.js';

export { normalizeKargolifeNumber, parseKargolife } from './parser.js';

/** The tracker page, which posts its form back to itself. */
export const KARGOLIFE_TRACKER = 'https://kargolife.com/index.php?url=kargolife/main';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

export class KargolifeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The form sends the number alone; no cookie or token is needed.
    const { response, bytes } = await fetchBounded(KARGOLIFE_TRACKER, {
      method: 'POST', signal, body: new URLSearchParams({ numberOfOrder: number }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', 'User-Agent': userAgentOf(this.options.userAgent) },
    }, { provider: PROVIDER, timeoutMs, maxBytes: KARGOLIFE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: REDIRECTS });
    // A redirect is a moved tracker, not a missing order.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Kargolife tracking moved', { status: response.status });
    return parseKargolife(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeKargolifeNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new KargolifeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
