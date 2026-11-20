import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { dypaqRequestNumber } from './number.js';
import { DYPAQ_MAX_BYTES, parseDypaq, PROVIDER } from './parser.js';

/** The tracking service behind the form on DYPAQ's home page. */
export const DYPAQ_TRACKING = 'https://www.dypaq.com/wp-json/dypaq_services/v1/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
// WordPress answers a route it no longer has with 404; a missing guía gets a reply of its own.
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class DypaqTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(DYPAQ_TRACKING, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ guia: number }) }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
      maxBytes: DYPAQ_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'DYPAQ tracking service is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'DYPAQ refused the lookup', { status: 403 });
    if (REDIRECTS.includes(response.status)) throw new SchemaError(PROVIDER, 'DYPAQ redirected its tracking service', { status: response.status });
    return parseDypaq(decodeText(bytes), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = dypaqRequestNumber(raw);
    // A lookup that fails to reach DYPAQ, or hangs, is asked again once: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'dypaq', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new DypaqTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'dypaq', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => dypaqRequestNumber(number))),
  };
};
