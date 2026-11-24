import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import {
  ChallengeError, IndeterminateError, InputRequiredError, MaintenanceError, NotFoundError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isTruskBlocked, parseTrusk, PROVIDER, TRUSK_LOOKUP, TRUSK_MAX_BYTES, truskJson, truskNotFound, truskOrderId } from './parser.js';

export { normalizeTruskNumber, parseTrusk, TRUSK_LOOKUP, truskOrderId } from './parser.js';

const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class TruskTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The read the order page's script makes. No session, token or CAPTCHA. */
  private async read(order: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${TRUSK_LOOKUP}${encodeURIComponent(order)}`, { method: 'GET', signal, headers: {
      Accept: 'application/json', Referer: `https://track.trusk.com/${order}`, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: TRUSK_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      if (isTruskBlocked(body)) throw new ChallengeError(PROVIDER, 'Trusk answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Trusk refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if ((status === 400 || status === 404) && json) {
      // An order id the lookup holds no order under gets HTTP 404 with its own error word. Any
      // other refusal leaves the answer open, and a 404 without it is a route the server no
      // longer has.
      const payload = truskJson(body);
      if (status === 404 && truskNotFound(payload)) throw new NotFoundError(PROVIDER, 'Trusk has no order under this link');
      if (status === 404) throw new TransportError(PROVIDER, 'Trusk tracking is unavailable', { status });
      throw new IndeterminateError(PROVIDER, 'Trusk did not complete the lookup', { status });
    }
    // A redirect, or a 404 without the lookup's JSON, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Trusk tracking is unavailable', { status });
    if (!json) {
      if (isTruskBlocked(body)) throw new ChallengeError(PROVIDER, 'Trusk answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Trusk answered with a page instead of its order reply');
    }
    return parseTrusk(truskJson(body));
  }

  async fetch(raw: string, trackingUrl: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const order = truskOrderId(trackingUrl, raw);
    // A read that fails to reach the lookup, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(order, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(order, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Trusk for a number, and the lookup needs the link.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new TruskTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => {
      if (!input.trackingUrl) throw new InputRequiredError(PROVIDER, 'trackingUrl', 'Trusk requires the order link');
      return tracker.fetch(input.number, input.trackingUrl, context);
    },
  };
};
