import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { IQFULFILLMENT_MAX_BYTES, isIqFulfillmentNotFound, normalizeIqFulfillmentNumber, parseIqFulfillment, PROVIDER } from './parser.js';

export { normalizeIqFulfillmentNumber, parseIqFulfillment } from './parser.js';

/** The tracking page, which takes the reference as `deliveryNo`. */
export const IQFULFILLMENT_PAGE = 'https://track.iqfulfillment.com';
/** The service the page asks for one reference's milestones. */
export const IQFULFILLMENT_HISTORY = 'https://iqintegrate.com/v1/tracking/history';
// The page's bundle sends this header with every request; the service picks the tracker by the page's origin.
const X_DOMAIN = 'tracktest.iqfulfillment.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha/i;
const DEFAULT_BUDGET_MS = 20_000;

export class IqFulfillmentTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(IQFULFILLMENT_HISTORY, { method: 'POST', signal,
      body: JSON.stringify({ tracking_number: number }), headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-Domain': X_DOMAIN,
        Origin: IQFULFILLMENT_PAGE, Referer: `${IQFULFILLMENT_PAGE}/`, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: IQFULFILLMENT_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 404, 410] });
    // An unknown reference is HTTP 404 with the service's own message; a redirect or a 410 is a moved route.
    if (response.status !== 200 && response.status !== 404) throw new TransportError(PROVIDER, 'IQ Fulfillment tracking moved', { status: response.status });
    const body = decodeText(bytes);
    if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'IQ Fulfillment answered with a browser check');
      if (response.status === 404) throw new TransportError(PROVIDER, 'IQ Fulfillment tracking moved', { status: 404 });
      throw new SchemaError(PROVIDER, 'IQ Fulfillment answered with a page instead of its tracking reply');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      throw new SchemaError(PROVIDER, 'IQ Fulfillment returned a reply that is not JSON', { cause: error });
    }
    if (response.status === 404) {
      if (isIqFulfillmentNotFound(payload)) throw new NotFoundError(PROVIDER, 'IQ Fulfillment has no order under this reference');
      // "Invalid domain", for one, refuses the page's origin: the tracker changed, the order is not missing.
      throw new TransportError(PROVIDER, 'IQ Fulfillment refused the tracking request', { status: 404 });
    }
    return parseIqFulfillment(payload, number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeIqFulfillmentNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new IqFulfillmentTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
