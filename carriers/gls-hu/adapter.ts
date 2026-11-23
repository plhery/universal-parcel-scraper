import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GLS_OVERVIEW_NOT_FOUND, glsLastError, parseGLSParcel } from '../gls-ch/adapter.js';

const PROVIDER = 'GLS Hungary';
// The GLS group's tracking service under Hungary's own path, as GLS Hungary's
// tracking page asks it. The group path answers GLS Hungary's national parcel
// numbers as unknown.
const OVERVIEW = 'https://gls-group.eu/app/service/open/rest/HU/en/rstt029';
const TIMEOUT_MS = 15_000;
// A national parcel number: 10 digits, or 11 written with a leading zero.
const NUMBER = /^\d{10,11}$/;

/** A GLS Hungary parcel number as its tracker takes it. */
export function normalizeGLSHungaryNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GLS Hungary tracks its 10- or 11-digit parcel numbers');
  return number;
}

/** The overview request GLS Hungary's tracking page makes, in its English locale. */
export function glsHungaryOverviewUrl(raw: string, millis = Date.now()): string {
  return `${OVERVIEW}?${new URLSearchParams({ match: normalizeGLSHungaryNumber(raw), type: '', caller: 'witt002', millis: String(millis) })}`;
}

/**
 * The overview's row for the requested parcel, read as GLS's other networks
 * read theirs. It holds the progress bar and no scans: the page shows the scans
 * only with the delivery postcode, so the status is the answer, marked
 * `summary_only`.
 */
export function parseGLSHungaryOverview(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGLSHungaryNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.tuStatus)) throw new SchemaError(PROVIDER, 'GLS Hungary returned an invalid overview');
  const rows = payload.tuStatus.filter(isRecord);
  // GLS answers a number it does not know with its 404; an empty list is not that answer.
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'GLS Hungary returned no parcel');
  const matching = rows.filter((row) => typeof row.tuNo === 'string' && returnedTrackingNumber(row.tuNo) === number);
  if (matching.length !== 1) {
    throw new SchemaError(PROVIDER, matching.length ? 'GLS Hungary returned an ambiguous parcel' : 'GLS Hungary returned a different parcel');
  }
  const row = matching[0]!;
  if (!isRecord(row.progressBar)) throw new SchemaError(PROVIDER, 'GLS Hungary returned no parcel status');
  const result = parseGLSParcel(row);
  if (result.status === 'unknown') throw new IndeterminateError(PROVIDER, 'GLS Hungary shows no status for this parcel');
  return { ...result, canonical_tracking_number: number, summary_only: true, timezone: 'Europe/Budapest' };
}

/**
 * The day the overview gives the requested parcel: the day GLS first had its data. A parcel keeps it
 * from pre-advice to delivery, as its archived replies in numbers.json show.
 */
export function glsHungaryParcelDay(payload: unknown, raw: string): string | null {
  const number = normalizeGLSHungaryNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.tuStatus)) return null;
  const rows = payload.tuStatus.filter((row) => isRecord(row) && typeof row.tuNo === 'string' && returnedTrackingNumber(row.tuNo) === number);
  const day = rows.length === 1 && isRecord(rows[0]) ? rows[0].date : undefined;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) ? day : null;
}

export class GLSHungaryTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGLSHungaryNumber(raw);
    return parseGLSHungaryOverview(await this.overview(number, context), number);
  }

  /**
   * Whether GLS Hungary knows the number. Its ten digits are other carriers' numbers too, and GLS knows
   * another parcel under some of them: the answer gives the parcel's day, the overview's only clock, so a
   * consumer sets aside a parcel quiet for two months or more.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    const seen: { day?: string | null } = {};
    const answer = await recognizeFromLookup(async () => {
      const number = normalizeGLSHungaryNumber(raw);
      const payload = await this.overview(number, context);
      seen.day = glsHungaryParcelDay(payload, number);
      return parseGLSHungaryOverview(payload, number);
    }, () => accepted(() => normalizeGLSHungaryNumber(raw)));
    return answer.known && seen.day && !answer.lastActivityAt && !answer.lastActivityLocal
      ? { ...answer, lastActivityLocal: `${seen.day}T00:00:00` } : answer;
  }

  private async overview(number: string, context: TrackingContext): Promise<unknown> {
    const budget = lookupBudget(context, TIMEOUT_MS);
    // A request that fails to reach GLS, or hangs, is sent once more within the budget.
    const { response, bytes } = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(
      glsHungaryOverviewUrl(number, (this.options.now ?? Date.now)()), {
        signal: budget.signal,
        headers: { Accept: 'application/json', Referer: 'https://gls-group.com/HU/hu/csomagkovetes/', 'User-Agent': userAgentOf(this.options.userAgent) },
      }, {
        provider: PROVIDER,
        timeoutMs: Math.min(TIMEOUT_MS, timeoutMs),
        maxBytes: 1_000_000,
        allowHttpError: true,
        ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
      }));
    // Only GLS's own not-found codes are a missing parcel; any other 404 leaves the answer open.
    if (response.status === 404) {
      if (GLS_OVERVIEW_NOT_FOUND.includes(glsLastError(bytes))) throw new NotFoundError(PROVIDER);
      throw new IndeterminateError(PROVIDER, 'GLS Hungary returned HTTP 404 without its own not-found reply', { status: 404 });
    }
    if (!response.ok) throw new UpstreamHttpError(PROVIDER, response.status);
    return parseJsonBytes(bytes, PROVIDER);
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new GLSHungaryTracker({ fetcher: environment.fetcher, userAgent: environment.userAgent });
  return {
    id: 'gls-hu',
    steps: ['direct'],
    track: (input, context) => tracker.fetch(input.number, context),
    recognize: (number, context) => tracker.recognize(number, context),
  };
};
