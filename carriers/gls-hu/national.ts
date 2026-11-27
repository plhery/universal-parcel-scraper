import { accepted, lookupBudget, recognizeFromLookup, type AdapterFactory, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError, UpstreamHttpError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { withNetworkRetry } from '../../core/runner/networkRetry.js';
import { fetchBounded, parseJsonBytes, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { GLS_OVERVIEW_NOT_FOUND, glsLastError, parseGLSParcel } from '../gls-ch/adapter.js';

/**
 * A GLS national network whose own parcel numbers exist only under its country's path of the
 * group's tracking service: the group path that gls-de and gls-ch ask answers them as unknown.
 */
export interface GLSNationalNetwork {
  /** The carrier's id. */
  readonly id: string;
  /** The network's name, as errors give it. */
  readonly provider: string;
  /** The country path of the tracking service. */
  readonly country: string;
  /** The network's zone, the zone of the parcel's day. */
  readonly timezone: string;
  /** The network's tracking page, which makes the overview request. */
  readonly page: string;
}

const TIMEOUT_MS = 15_000;
// A national parcel number: 10 digits, or 11 written with a leading zero.
const NUMBER = /^\d{10,11}$/;

/** A national parcel number as the network's tracker takes it. */
export function normalizeGLSNationalNumber(network: GLSNationalNetwork, raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!NUMBER.test(number)) throw new InvalidInputError(network.provider, `${network.provider} tracks its 10- or 11-digit parcel numbers`);
  return number;
}

/** The overview request the network's tracking page makes, in its English locale. */
export function glsNationalOverviewUrl(network: GLSNationalNetwork, raw: string, millis = Date.now()): string {
  const query = new URLSearchParams({ match: normalizeGLSNationalNumber(network, raw), type: '', caller: 'witt002', millis: String(millis) });
  return `https://gls-group.eu/app/service/open/rest/${network.country}/en/rstt029?${query}`;
}

/**
 * The overview's row for the requested parcel, read as GLS's other networks read theirs. It holds
 * the progress bar and no scans: the page shows the scans only with the delivery postcode, so the
 * status is the answer, marked `summary_only`.
 */
export function parseGLSNationalOverview(network: GLSNationalNetwork, payload: unknown, raw: string): CarrierResult {
  const { provider } = network;
  const number = normalizeGLSNationalNumber(network, raw);
  if (!isRecord(payload) || !Array.isArray(payload.tuStatus)) throw new SchemaError(provider, `${provider} returned an invalid overview`);
  const rows = payload.tuStatus.filter(isRecord);
  // GLS answers a number it does not know with its 404; an empty list is not that answer.
  if (!rows.length) throw new IndeterminateError(provider, `${provider} returned no parcel`);
  const matching = rows.filter((row) => typeof row.tuNo === 'string' && returnedTrackingNumber(row.tuNo) === number);
  if (matching.length !== 1) {
    throw new SchemaError(provider, matching.length ? `${provider} returned an ambiguous parcel` : `${provider} returned a different parcel`);
  }
  const row = matching[0]!;
  if (!isRecord(row.progressBar)) throw new SchemaError(provider, `${provider} returned no parcel status`);
  const result = parseGLSParcel(row);
  if (result.status === 'unknown') throw new IndeterminateError(provider, `${provider} shows no status for this parcel`);
  return { ...result, canonical_tracking_number: number, summary_only: true, timezone: network.timezone };
}

/**
 * The day the overview gives the requested parcel: the day GLS first had its data. A parcel keeps
 * it from pre-advice to delivery.
 */
export function glsNationalParcelDay(network: GLSNationalNetwork, payload: unknown, raw: string): string | null {
  const number = normalizeGLSNationalNumber(network, raw);
  if (!isRecord(payload) || !Array.isArray(payload.tuStatus)) return null;
  const rows = payload.tuStatus.filter((row) => isRecord(row) && typeof row.tuNo === 'string' && returnedTrackingNumber(row.tuNo) === number);
  const day = rows.length === 1 && isRecord(rows[0]) ? rows[0].date : undefined;
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) ? day : null;
}

export class GLSNationalTracker {
  constructor(
    private readonly network: GLSNationalNetwork,
    private readonly options: { fetcher?: typeof fetch; userAgent?: string; now?: () => number } = {},
  ) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeGLSNationalNumber(this.network, raw);
    return parseGLSNationalOverview(this.network, await this.overview(number, context), number);
  }

  /**
   * Whether the network knows the number. Its digits are other carriers' numbers too, and GLS knows
   * another parcel under some of them: the answer gives the parcel's day, the overview's only clock,
   * so a consumer sets aside a parcel quiet for two months or more.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    const seen: { day?: string | null } = {};
    const answer = await recognizeFromLookup(async () => {
      const number = normalizeGLSNationalNumber(this.network, raw);
      const payload = await this.overview(number, context);
      seen.day = glsNationalParcelDay(this.network, payload, number);
      return parseGLSNationalOverview(this.network, payload, number);
    }, () => accepted(() => normalizeGLSNationalNumber(this.network, raw)));
    return answer.known && seen.day && !answer.lastActivityAt && !answer.lastActivityLocal
      ? { ...answer, lastActivityLocal: `${seen.day}T00:00:00` } : answer;
  }

  private async overview(number: string, context: TrackingContext): Promise<unknown> {
    const { provider } = this.network;
    const budget = lookupBudget(context, TIMEOUT_MS);
    // A request that fails to reach GLS, or hangs, is sent once more within the budget.
    const { response, bytes } = await withNetworkRetry(budget, (timeoutMs) => fetchBounded(
      glsNationalOverviewUrl(this.network, number, (this.options.now ?? Date.now)()), {
        signal: budget.signal,
        headers: { Accept: 'application/json', Referer: this.network.page, 'User-Agent': userAgentOf(this.options.userAgent) },
      }, {
        provider,
        timeoutMs: Math.min(TIMEOUT_MS, timeoutMs),
        maxBytes: 1_000_000,
        allowHttpError: true,
        ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
      }));
    // Only GLS's own not-found codes are a missing parcel; any other 404 leaves the answer open.
    if (response.status === 404) {
      if (GLS_OVERVIEW_NOT_FOUND.includes(glsLastError(bytes))) throw new NotFoundError(provider);
      throw new IndeterminateError(provider, `${provider} returned HTTP 404 without its own not-found reply`, { status: 404 });
    }
    if (!response.ok) throw new UpstreamHttpError(provider, response.status);
    return parseJsonBytes(bytes, provider);
  }
}

/** The network's adapter: one direct overview lookup, and recognition through the same request. */
export function glsNationalAdapter(network: GLSNationalNetwork): AdapterFactory {
  return (environment) => {
    const tracker = new GLSNationalTracker(network, { fetcher: environment.fetcher, userAgent: environment.userAgent });
    return {
      id: network.id,
      steps: ['direct'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => tracker.recognize(number, context),
    };
  };
}
