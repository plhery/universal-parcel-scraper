import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, SchemaError, TransportError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  normalizeRhenusDeNumber, normalizeRhenusDePostcode, parseRhenusDe, PROVIDER, readRhenusDeOrder, RHENUS_DE_MAX_BYTES,
} from './parser.js';

export { normalizeRhenusDeNumber, normalizeRhenusDePostcode, parseRhenusDe, readRhenusDeOrder } from './parser.js';

// The booking service rhenusmydelivery.com's page asks, as its environment.json names it.
const API = 'https://rhemate.com/order-manager/booking/api/SelfScheduling';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 20_000;

/** The portal's lookup of an order by its number and delivery postcode. */
export const rhenusDeOrderUrl = (number: string, postcode: string): string =>
  `${API}/Order/OrderNumber/${encodeURIComponent(number)}/PostalCode/${encodeURIComponent(postcode)}`;

/** The steps of an order, by the id the lookup gives it. */
export const rhenusDeTrackingUrl = (internalOrderId: string): string =>
  `${API}/order-tracking-status/${encodeURIComponent(internalOrderId)}`;

/** The same failure without the request and response details fetchBounded attaches: the lookup's address holds the postcode. */
function withoutPostcode(error: unknown): unknown {
  if (error instanceof UpstreamHttpError) return new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
  if (error instanceof UpstreamNetworkError) return new UpstreamNetworkError(error.provider, error.cause);
  return error;
}

export class RhenusDeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async get(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    let response: Response;
    let bytes: Uint8Array;
    try {
      ({ response, bytes } = await fetchBounded(url, { signal, headers: {
        Accept: 'application/json', 'RH-Locale': 'de', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RHENUS_DE_MAX_BYTES, redirect: 'manual',
        fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403] }));
    } catch (error) {
      throw withoutPostcode(error);
    }
    if (response.status === 403) throw new ChallengeError(PROVIDER, 'Rhenus refused the lookup', { status: 403 });
    // A redirect is a moved service, not a missing order.
    if (response.status !== 200) throw new TransportError(PROVIDER, 'Rhenus moved its booking service', { status: response.status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) throw new SchemaError(PROVIDER, 'Rhenus answered with a page');
    return decodeText(bytes);
  }

  private async read(number: string, postcode: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const ends = Date.now() + timeoutMs;
    const order = readRhenusDeOrder(await this.get(rhenusDeOrderUrl(number, postcode), signal, timeoutMs), number);
    return parseRhenusDe(order, await this.get(rhenusDeTrackingUrl(order.internalOrderId), signal, ends - Date.now()));
  }

  async fetch(raw: string, rawPostcode: string | null | undefined, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRhenusDeNumber(raw);
    // Without the postcode the portal shows nothing, so no request is made.
    const postcode = normalizeRhenusDePostcode(rawPostcode);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, postcode, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, postcode, signal, remainingMs)),
    ]);
  }
}

// No recognition: every lookup needs the postcode, and an unknown number and a wrong postcode get
// the same answer.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RhenusDeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, input.postcode, context),
  };
};
