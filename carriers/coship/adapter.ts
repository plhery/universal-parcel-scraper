import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { COSHIP_LOOKUP, COSHIP_MAX_BYTES, coshipJson, isCoshipBlocked, isCoshipOceanNumber, normalizeCoshipNumber, parseCoship, PROVIDER } from './parser.js';

export { COSHIP_LOOKUP, normalizeCoshipNumber, parseCoship } from './parser.js';

const TRACKER_PAGE = 'https://www.coship.ca/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class CoshipTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The read the tracking page's script makes for each number. No session, key or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(`${COSHIP_LOOKUP}${encodeURIComponent(number)}`, { signal, headers: {
      Accept: 'application/json', Referer: TRACKER_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: COSHIP_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 401 || status === 403 || status === 503) {
      if (isCoshipBlocked(body)) throw new ChallengeError(PROVIDER, 'COSHIP answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'COSHIP refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The tracker answers an unknown number with HTTP 200; a redirect or a missing route is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'COSHIP tracking is unavailable', { status });
    if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
      if (isCoshipBlocked(body)) throw new ChallengeError(PROVIDER, 'COSHIP answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'COSHIP answered with a page instead of its tracking reply');
    }
    return parseCoship(coshipJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCoshipNumber(raw);
    // The tracking page answers these itself: COSHIP reports an ocean shipment's steps by email.
    if (isCoshipOceanNumber(number)) throw new IndeterminateError(PROVIDER, 'COSHIP does not track ocean shipments online');
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: the numbers seen are thirteen digits from Korea Post's domestic parcel range, and
// no detection rule offers COSHIP, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CoshipTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
