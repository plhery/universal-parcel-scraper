import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, MaintenanceError, NotFoundError, RateLimitedError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import {
  CARGOMINI_MAX_BYTES, CARRIER, cargominiJson, isCargominiBlocked, normalizeCargominiNumber, parseCargomini, PROVIDER,
} from './parser.js';

export { normalizeCargominiNumber, parseCargomini } from './parser.js';

/** The tracking page, whose script asks the tracker. */
export const CARGOMINI_PAGE = 'https://tracking.cargomini.com/';
/** KargomKolay's tracking service, which the page asks with the number as the path. */
export const CARGOMINI_TRACK = 'https://api.kargomkolay.com/v1/tracking/';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The tracker's address for one number, as the page's script builds it. */
export function cargominiLookupUrl(number: string): string {
  return `${CARGOMINI_TRACK}${encodeURIComponent(number)}`;
}

/**
 * The tracker's own answer for a number it holds no consignment under: HTTP 404 with a problem
 * reply. A path the service does not route gets an empty 404 instead.
 */
function isNotFound(body: string, contentType: string): boolean {
  if (!/^application\/problem\+json\b/i.test(contentType)) return false;
  try {
    const problem: unknown = JSON.parse(body);
    return isRecord(problem) && problem.status === 404 && problem.title === 'Not Found';
  } catch {
    return false;
  }
}

export class CargominiTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    const { response, bytes } = await fetchBounded(cargominiLookupUrl(number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Origin: 'https://tracking.cargomini.com', Referer: CARGOMINI_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: CARGOMINI_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 429, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    const contentType = response.headers.get('content-type') ?? '';
    if (status === 403 || status === 503) {
      if (response.headers.get('cf-mitigated') === 'challenge' || isCargominiBlocked(body)) {
        throw new ChallengeError(PROVIDER, 'CargoMini answered with a browser check', { status });
      }
      if (status === 403) throw new ChallengeError(PROVIDER, 'CargoMini refused the lookup', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    if (status === 429) throw new RateLimitedError(PROVIDER);
    if (status === 404) {
      if (isNotFound(body, contentType)) throw new NotFoundError(PROVIDER, 'CargoMini has no consignment under this number');
      throw new TransportError(PROVIDER, 'CargoMini tracking is unavailable', { status });
    }
    // A redirect or another status is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'CargoMini tracking is unavailable', { status });
    if (!/^application\/json\b/i.test(contentType)) {
      if (isCargominiBlocked(body)) throw new ChallengeError(PROVIDER, 'CargoMini answered with a browser check', { status });
      throw new SchemaError(PROVIDER, 'CargoMini answered with a page instead of its tracking reply');
    }
    return parseCargomini(cargominiJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeCargominiNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers CargoMini, so preflight never asks it.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new CargominiTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
