import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import {
  isRecibeloBlocked, normalizeRecibeloNumber, parseRecibelo, PROVIDER, RECIBELO_LOOKUP, RECIBELO_MAX_BYTES, RECIBELO_NOT_FOUND, recibeloJson,
} from './parser.js';

export { normalizeRecibeloNumber, parseRecibelo, RECIBELO_LOOKUP } from './parser.js';

const TRACKER_PAGE = 'https://www.recibelo.cl/seguimiento/';
const REDIRECTS = [301, 302, 303, 307, 308];
const JSON_TYPE = /^application\/(?:problem\+)?json\b/i;
const DEFAULT_BUDGET_MS = 15_000;

export class RecibeloTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The lookup the tracking page's script makes. No session, token or CAPTCHA. */
  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const url = `${RECIBELO_LOOKUP}?internal_ids[]=${encodeURIComponent(number)}`;
    const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Origin: 'https://www.recibelo.cl', Referer: TRACKER_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, {
      provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RECIBELO_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 503],
    });
    const { status } = response;
    const body = decodeText(bytes);
    const json = JSON_TYPE.test(response.headers.get('content-type') ?? '');
    if (status === 401 || status === 403 || status === 503) {
      if (isRecibeloBlocked(body)) throw new ChallengeError(PROVIDER, 'Recíbelo answered with a browser check', { status });
      if (status !== 503) throw new ChallengeError(PROVIDER, 'Recíbelo refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if (status === 404) {
      // Only the tracker's own answer is not found; any other 404 is a route the server no longer has.
      if (json && recibeloJson(body) === RECIBELO_NOT_FOUND) throw new NotFoundError(PROVIDER, 'Recíbelo has no parcel under this number');
      throw new TransportError(PROVIDER, 'Recíbelo tracking is unavailable', { status });
    }
    if (status !== 200) throw new TransportError(PROVIDER, 'Recíbelo tracking is unavailable', { status });
    if (!json) {
      if (isRecibeloBlocked(body)) throw new ChallengeError(PROVIDER, 'Recíbelo answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'Recíbelo answered with a page instead of its tracking reply');
    }
    return parseRecibelo(recibeloJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeRecibeloNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half
    // of the budget. An HTTP status or a reply is never sent again.
    return runSteps({ carrier: PROVIDER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Recíbelo for a number, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new RecibeloTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: PROVIDER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
