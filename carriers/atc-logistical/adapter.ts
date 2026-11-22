import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { atcLookupUrl, atcPageUrl, isAtcChallenge, normalizeAtcNumber, parseAtcPage, PROVIDER } from './parser.js';

export { ATC_LOOKUP, atcLookupUrl, atcPageUrl, normalizeAtcNumber, parseAtcPage } from './parser.js';

// A redirect or a missing page is a moved tracker, not a missing consignment.
const MOVED = [301, 302, 303, 307, 308, 404, 410];
const LOOKUP_MAX_BYTES = 16_000;
const PAGE_MAX_BYTES = 400_000;
const DEFAULT_BUDGET_MS = 20_000;

export class AtcTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, signal: AbortSignal, timeoutMs: number, maxBytes: number, accept: string): Promise<string> {
    const { response, bytes } = await fetchBounded(url, { signal, headers: { Accept: accept, 'User-Agent': userAgentOf(this.options.userAgent) } },
      { provider: PROVIDER, timeoutMs, maxBytes, redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: MOVED });
    if (response.status !== 200) throw new TransportError(PROVIDER, 'ATC tracking moved', { status: response.status });
    return decodeText(bytes);
  }

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const deadline = Date.now() + timeoutMs;
    // The Track Shipment form asks the lookup for the number's page, then opens that page.
    const lookup = await this.get(atcLookupUrl(number), signal, timeoutMs, LOOKUP_MAX_BYTES, 'application/json, text/javascript, */*; q=0.01');
    let payload: unknown;
    try {
      payload = JSON.parse(lookup);
    } catch (error) {
      if (isAtcChallenge(lookup)) throw new ChallengeError(PROVIDER, 'ATC answered with a browser check');
      throw new SchemaError(PROVIDER, 'ATC returned a lookup reply that is not JSON', { cause: error });
    }
    const page = await this.get(atcPageUrl(payload), signal, Math.max(1, deadline - Date.now()), PAGE_MAX_BYTES, 'text/html');
    return parseAtcPage(page, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAtcNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new AtcTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
