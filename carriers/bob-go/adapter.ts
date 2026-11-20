import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { bobGoRequestNumber } from './number.js';
import { BOB_GO_MAX_BYTES, bobGoMissing, parseBobGo, PROVIDER } from './parser.js';

/** The service Bob Go's tracker at track.bobgo.co.za asks. */
export const BOB_GO_TRACKING = 'https://api.bobgo.co.za/tracking';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 405, 410];
const DEFAULT_BUDGET_MS = 20_000;

export class BobGoTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${BOB_GO_TRACKING}?tracking_reference=${encodeURIComponent(number)}`;
    const { response, bytes } = await fetchBounded(url, { signal, headers: {
      Accept: 'application/json', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BOB_GO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 403, 500] });
    if (GONE.includes(response.status)) throw new TransportError(PROVIDER, 'Bob Go tracking service is unavailable', { status: response.status });
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Bob Go refused the lookup', { status: 403 });
    if (REDIRECTS.includes(response.status)) throw new SchemaError(PROVIDER, 'Bob Go redirected its tracking service', { status: response.status });
    const body = decodeText(bytes);
    if (response.status === 500) {
      // Bob Go answers a reference it does not hold with HTTP 500 and a message naming it.
      if (bobGoMissing(body, number)) throw new NotFoundError(PROVIDER);
      throw new UpstreamHttpError(PROVIDER, 500);
    }
    return parseBobGo(body, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = bobGoRequestNumber(raw);
    // A lookup that fails to reach Bob Go, or hangs, is asked again once: the
    // first try gets half of the budget.
    return runSteps({ carrier: 'bob-go', budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new BobGoTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'bob-go', recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context),
      () => accepted(() => bobGoRequestNumber(number))),
  };
};
