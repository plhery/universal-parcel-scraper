import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { BARQ_LOOKUP, BARQ_MAX_BYTES, BARQ_QUERY, barqJson, isBarqBlocked, normalizeBarqNumber, parseBarq, PROVIDER } from './parser.js';

export { BARQ_LOOKUP, normalizeBarqNumber, parseBarq } from './parser.js';

const TRACKER_ORIGIN = 'https://web.barqfleet.com';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:graphql-response\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class BarqTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The query the tracking page posts. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(BARQ_LOOKUP, { method: 'POST', signal, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: TRACKER_ORIGIN, Referer: `${TRACKER_ORIGIN}/`,
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: JSON.stringify({ query: BARQ_QUERY, variables: { trackingNo: number } }) }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: BARQ_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 401, 403, 404, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isBarqBlocked(body)) throw new ChallengeError(PROVIDER, 'BARQ answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'BARQ refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The service answers an unknown number with HTTP 200 and its errors; any other status is a
    // moved or changed service, never a missing order.
    if (status !== 200) throw new TransportError(PROVIDER, 'BARQ tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isBarqBlocked(body)) throw new ChallengeError(PROVIDER, 'BARQ answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'BARQ answered with a page instead of its tracking reply');
    }
    return parseBarq(barqJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeBarqNumber(raw);
    // A read that fails to reach the service, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers BARQ for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new BarqTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
