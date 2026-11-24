/**
 * The re-toms order system's guest track query, which Kuayuan Express and WLD
 * Express each run as a tenant on their own host: the page's script posts the
 * method `getTrackInfoOutside` to `https://<host>/api/re-toms/v1` and reads one
 * entry per number asked. Each carrier keeps its host, token, number format,
 * not-found wording and status map; this module holds the request and the
 * parser they share.
 */
import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import type { TrackingContext } from '../../core/adapter/index.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

/** The track query's method. */
export const RETOMS_METHOD = 'getTrackInfoOutside';
// A long history is a few kilobytes of JSON.
export const RETOMS_MAX_BYTES = 256 * 1024;

/** One carrier's tenant of the order system. */
export interface RetomsTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The endpoint the tenant's page posts to, `https://<host>/api/re-toms/v1`. */
  readonly api: string;
  /** The page that sends the lookup, which the request names as its origin and referrer. */
  readonly page: string;
  /** The tenant's numbers, in upper case without separators. */
  readonly number: RegExp;
  /** Those numbers in words, for the refusal of anything else: "a digit, three letters and ten digits". */
  readonly numberFormat: string;
  /**
   * The token the page sends: the same one for every request, or one signed
   * per request with the key the page's script gives every visitor.
   */
  readonly auth: { readonly token: string } | { readonly signingKey: string };
  /** The message of an `ask: 0` entry that says the tenant does not hold the number it names. */
  readonly notFound: RegExp;
  /**
   * A scan's stage by its code and wording, from the tenant's map, else the
   * shared wording rules. The line's scans come under `ND` in the line's words:
   * a tenant that writes delivery attempts there too stages them by wording.
   */
  readonly stage: (code: string | null, wording: string) => ClassifiedWording | null;
  /** The tenant's map, which tells a newer scan that moves nothing from one that may undo a delivery. */
  readonly statusMap: CarrierStatusMap;
  /** A scan's place: the length kept, and whether the place is written `office|town`, read "office, town". */
  readonly place: { readonly maxLength: number; readonly officeTown?: true };
  /** The shipment's numbers, one of which must be the number asked. */
  readonly identity: readonly ('shipper_hawbcode' | 'server_hawbcode')[];
  /**
   * The line's number (`server_hawbcode`), when it holds a digit, becomes
   * `delivery_tracking_number` even when no carrier's high-confidence rule
   * claims it, as the tenant's page shows it as the tracking number.
   */
  readonly keepsLine?: true;
  /** The recipient's name and town become `receiver_name` and `receiver_address`. */
  readonly recipient?: true;
}

export type RetomsTrackerOptions = { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string };

const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|acw_sc__v2|aliyun_waf|waf\.tencent|captcha|人机验证|滑动验证|<title>\s*(?:Just a moment|Attention Required|Access denied)/i;
// "2026-11-02 22:14:19": a wall clock without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z]{1,12}$/;
const BUSY = /频繁|too many|rate limit/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;

/** A tenant's number in upper case, as its tracker reads it; anything else is not one the tenant issues. */
export function normalizeRetomsNumber(raw: string, tenant: RetomsTenant): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!tenant.number.test(number)) throw new InvalidInputError(tenant.provider, `${tenant.provider} numbers are ${tenant.numberFormat}`);
  return number;
}

/**
 * The token the tenant's page sends with a request made at `timestamp`. A
 * signed one is twenty hex digits from the MD5 of the method, the timestamp,
 * the key and the customer code and login key a guest does not have, which the
 * script writes as "undefined".
 */
export function retomsToken(tenant: RetomsTenant, timestamp: number): string {
  const { auth } = tenant;
  if ('token' in auth) return auth.token;
  return createHash('md5').update(`${RETOMS_METHOD}${timestamp}undefined${auth.signingKey}undefined`).digest('hex').slice(8, 28);
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, provider: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A text field the result can do without: anything but a string is left out. */
function optional(row: Record<string, unknown>, key: string, maxLength = 120): string {
  const value = row[key];
  return typeof value === 'string' ? clean(value, maxLength) : '';
}

/** A scan's date and second as one wall time. The reply gives no zone. */
function wallClock(raw: string, provider: string): string {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  return local;
}

/** A scan's place, its `office|town` read "office, town" where the tenant writes it so. */
function place(row: Record<string, unknown>, tenant: RetomsTenant): string {
  const raw = text(row, 'track_location', tenant.provider, tenant.place.maxLength);
  if (!tenant.place.officeTown) return raw;
  const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
  return [...new Set(parts)].join(', ');
}

/**
 * The number the tenant gave the parcel's line, when it is not the number
 * asked. The reply names no line, so its carrier is named only when one
 * carrier's high-confidence rule claims the number.
 */
function handoff(shipment: Record<string, unknown>, number: string, tenant: RetomsTenant): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const line = normalizeTrackingNumber(text(shipment, 'server_hawbcode', tenant.provider, 64));
  if (!/^[A-Z0-9]{4,40}$/.test(line) || (tenant.keepsLine && !/\d/.test(line)) || line === number) return {};
  const detected = detectCarrierMatch(line);
  if (detected.confidence === 'high' && (detected.carrier as string) !== tenant.carrier) {
    return { delivery_carrier: detected.carrier, delivery_tracking_number: line };
  }
  return tenant.keepsLine ? { delivery_tracking_number: line } : {};
}

/**
 * The reply of the page's `getTrackInfoOutside` call: `detail['']` lists one
 * entry per number asked. A number the tracker knows is `ask: 1` with the
 * shipment: the tenant's number (`shipper_hawbcode`), the line's
 * (`server_hawbcode`), the destination's code and the scans, newest first,
 * each a wall clock, a place, a wording and a code. One it does not hold is
 * `ask: 0` with the tenant's wording. The shipment must be the number asked.
 * The customer's reference is not read, and the recipient's name and town only
 * for a tenant that keeps them.
 */
export function parseRetoms(payload: unknown, raw: string, tenant: RetomsTenant): CarrierResult {
  const { provider } = tenant;
  const number = normalizeRetomsNumber(raw, tenant);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (payload.code !== 200) {
    if (BUSY.test(clean(payload.message, 200))) throw new RateLimitedError(provider);
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  const detail = isRecord(payload.data) ? payload.data.detail : undefined;
  const entries = isRecord(detail) ? detail[''] : undefined;
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SHIPMENTS || !entries.every(isRecord)) {
    throw new SchemaError(provider, `${provider} returned an invalid result list`);
  }
  const entry = (entries as Record<string, unknown>[]).find((candidate) => normalizeTrackingNumber(text(candidate, 'code', provider, 64)) === number);
  if (!entry) throw new IndeterminateError(provider, `${provider} answered for another shipment`);
  if (entry.ask === 0) {
    if (tenant.notFound.test(text(entry, 'message', provider))) throw new NotFoundError(provider);
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  const shipment = entry.data;
  if (entry.ask !== 1 || !isRecord(shipment)) throw new SchemaError(provider, `${provider} returned an invalid shipment`);
  if (!tenant.identity.map((key) => text(shipment, key, provider, 64)).some((value) => normalizeTrackingNumber(value) === number)) {
    throw new IndeterminateError(provider, `${provider} answered for another shipment`);
  }
  const rows = shipment.track_detail_list ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned too many scans`);

  const scans: { local: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const local = wallClock(text(row, 'track_date', provider, 32), provider);
    const description = text(row, 'track_content', provider);
    if (!description) throw new SchemaError(provider, `${provider} returned a scan without wording`);
    const code = text(row, 'track_code', provider, 32);
    if (code && !CODE.test(code)) throw new SchemaError(provider, `${provider} returned an invalid scan code`);
    const location = place(row, tenant);
    const identity = JSON.stringify([local, code, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = tenant.stage(code || null, description);
    scans.push({ local, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  const partner = handoff(shipment, number, tenant);
  if (!scans.length) throw new NoHistoryError(provider, undefined, {
    deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number,
  });
  // The tracker lists scans newest first, including across local clock changes.
  // Reverse an oldest-first reply only if even the full UTC offset range cannot reverse its endpoints.
  if (Date.parse(scans.at(-1)!.local + 'Z') - Date.parse(scans[0]!.local + 'Z') > 26 * 3_600_000) scans.reverse();
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  // A delivery stands only while no newer scan may have undone it, unless that scan moves nothing (`leadingScan`).
  const current = leadingScan(events, tenant.statusMap);
  const stage = current?.stage as Stage | undefined;
  const country = countryCode(text(shipment, 'country_code', provider, 8));
  const name = tenant.recipient ? optional(shipment, 'consignee_name') : '';
  const town = tenant.recipient ? optional(shipment, 'shipp_to_location') : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: scans[0]!.local,
    ...(country ? { destination_country: country } : {}),
    ...(name ? { receiver_name: name } : {}),
    ...(town ? { receiver_address: town } : {}),
    ...partner,
    events,
  };
}

function json(body: string, provider: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/** One lookup on a tenant's track query, sent once more after a network failure. */
export class RetomsTracker {
  constructor(private readonly tenant: RetomsTenant, private readonly options: RetomsTrackerOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const { tenant } = this;
    const { provider } = tenant;
    const number = normalizeRetomsNumber(raw, tenant);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      // The page's own request for a guest, in English.
      const timestamp = Date.now();
      const body = JSON.stringify({ method: RETOMS_METHOD, param: { codes: number, noUserCode: '1' },
        timestamp, token: retomsToken(tenant, timestamp), lang: 'en_US' });
      const { response, bytes } = await fetchBounded(tenant.api, { method: 'POST', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json', Origin: new URL(tenant.page).origin,
        Referer: tenant.page, 'User-Agent': userAgentOf(this.options.userAgent),
      }, body }, { provider, timeoutMs: Math.max(1, Math.floor(timeoutMs)), maxBytes: RETOMS_MAX_BYTES,
        redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, 403, 404, 410] });
      const reply = decodeText(bytes);
      if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`, { status: response.status });
      if (response.status === 403) throw new ChallengeError(provider, `${provider} refused the lookup`, { status: 403 });
      if (response.status !== 200) throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: response.status });
      return parseRetoms(json(reply, provider), number, tenant);
    };
    // A read that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}
