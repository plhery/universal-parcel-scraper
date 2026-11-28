import { DateTime } from 'luxon';
import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, IndeterminateError, MaintenanceError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { AIRMEE_MAX_BYTES, airmeeJson, CARRIER, isAirmeeBlocked, normalizeAirmeeNumber, parseAirmee, PROVIDER } from './parser.js';

export { normalizeAirmeeNumber, parseAirmee } from './parser.js';

/** Airmee's public tracking page, whose script asks the lookup. */
export const AIRMEE_PAGE = 'https://tracking.airmee.com/';
export const AIRMEE_LOOKUP = 'https://api.airmee.com/track/public_track_shipment';
// The page asks for shipments inside a date range; a start before any shipment the tracker keeps leaves none out.
export const AIRMEE_FIRST_DAY = '2018-01-01';
const REDIRECTS = [301, 302, 303, 307, 308];
const DEFAULT_BUDGET_MS = 15_000;

/** The lookup for one shipment id, over every day from the tracker's first to tomorrow in UTC. */
export function airmeeLookupUrl(number: string, now: Date = new Date()): string {
  const tomorrow = DateTime.fromJSDate(now, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;
  return `${AIRMEE_LOOKUP}?shipment_id=${encodeURIComponent(number)}&min_date=${AIRMEE_FIRST_DAY}&max_date=${tomorrow}`;
}

export class AirmeeTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => Date } = {}) {}

  private async read(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    // The page sends no token or cookie: its own origin and the id with the date range.
    const { response, bytes } = await fetchBounded(airmeeLookupUrl(number, this.options.now?.()), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', Origin: AIRMEE_PAGE.slice(0, -1), Referer: AIRMEE_PAGE,
      'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider: PROVIDER, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: AIRMEE_MAX_BYTES, redirect: 'manual',
      fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 400, 403, 404, 410, 503] });
    const { status } = response;
    const body = decodeText(bytes);
    if (status === 403) {
      throw new ChallengeError(PROVIDER, isAirmeeBlocked(body) ? 'Airmee answered with a browser check' : 'Airmee refused the lookup', { status });
    }
    if (status === 503) {
      if (isAirmeeBlocked(body)) throw new ChallengeError(PROVIDER, 'Airmee answered with a browser check', { status });
      throw new MaintenanceError(PROVIDER, undefined, { status });
    }
    // The service answers a request it cannot read with HTTP 400 and its message; the id was checked before.
    if (status === 400) throw new IndeterminateError(PROVIDER, 'Airmee refused the lookup', { status });
    // A redirect, or a missing route, is a moved tracker.
    if (status !== 200) throw new TransportError(PROVIDER, 'Airmee tracking is unavailable', { status });
    if (!body.trim()) throw new SchemaError(PROVIDER, 'Airmee returned an empty reply');
    return parseAirmee(airmeeJson(body), number);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeAirmeeNumber(raw);
    // A read that fails to reach the tracker, or hangs, is sent once more: the first try gets half of the budget.
    return runSteps({ carrier: CARRIER, budgetMs: context.budgetMs ?? DEFAULT_BUDGET_MS, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => this.read(number, signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => this.read(number, signal, remainingMs)),
    ]);
  }
}

// No recognition: no detection rule offers Airmee for its ids, which share other carriers' shapes.
export const adapter: AdapterFactory = (environment) => {
  const tracker = new AirmeeTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: CARRIER, recordsSteps: true, steps: ['direct', 'retry'],
    track: (input, context) => tracker.fetch(input.number, context),
  };
};
