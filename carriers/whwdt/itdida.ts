import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, MaintenanceError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

// The ITDIDA platform Chinese forwarders run their portals on. Each forwarder
// has its own host, `<tenant>.itdida.com`, which some serve on their own
// domain too; the guest lookup and its reply are the same on every one.

// One parcel's reply is a few kilobytes.
export const ITDIDA_MAX_BYTES = 512 * 1024;
export const ITDIDA_REDIRECTS = [301, 302, 303, 307, 308];
// The status of the platform's "too busy" answer, given to a lookup that follows another closely.
export const ITDIDA_BUSY = 503;
// The answer for a number the tenant holds no waybill under: "the number does not exist".
export const ITDIDA_UNKNOWN = '单号不存在';
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const CODE = /^[A-Za-z0-9_-]{1,16}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// What a tenant's lookup takes when it issues several kinds of number: letters and digits, at least one a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const MAX_ROWS = 500;
// Four to six digits standing alone in a place are a postcode.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// Who took a delivered parcel, as a delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signatory|signature)\b.*$/i;

/** The guest lookup a tenant's tracking page makes for one number. */
export function itdidaLookupUrl(host: string, number: string): string {
  return `https://${host}/itdida-api/queryTracks?${new URLSearchParams({ no: number })}`;
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function itdidaJson(body: string, provider: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/** A 503 reply: the tenant's "too busy" answer is a rate limit, anything else maintenance. */
export function itdidaUnavailable(body: string, provider: string): never {
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    // Not the platform's answer.
  }
  if (isRecord(payload) && payload.success === false && payload.data === 'too busy') throw new RateLimitedError(provider);
  throw new MaintenanceError(provider);
}

/** An optional text field; anything but a string is a changed reply. */
export function itdidaText(row: Record<string, unknown>, key: string, provider: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

// The platform names the destination country in Chinese, as "美国".
const CHINESE_REGIONS = (() => {
  const names = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
  const map = new Map<string, string>();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (countryCode(code) !== code) continue;
      const name = names.of(code);
      if (name && name !== code && !map.has(name)) map.set(name, code);
    }
  }
  return map;
})();

/** The ISO code of a country the reply names in Chinese or English, or null. */
export function itdidaCountry(name: string): string | null {
  const value = name.trim();
  return CHINESE_REGIONS.get(value) ?? countryCode(value);
}

export interface ItdidaParcel {
  /** The waybill's summary: destination, onward number and the platform's status. */
  readonly detail: Record<string, unknown>;
  readonly rows: unknown[];
}

/**
 * The entry of a `queryTracks` reply for the whole number asked. A number the
 * tenant does not know comes back as an entry without a waybill and with its
 * "the number does not exist" message. A lookup sent too soon after another
 * gets HTTP 503 with `"data":"too busy"`, which is a rate limit.
 */
export function itdidaEntry(payload: unknown, number: string, provider: string): ItdidaParcel {
  if (isRecord(payload) && payload.success === false && (payload.statusCode === ITDIDA_BUSY || payload.data === 'too busy')) {
    throw new RateLimitedError(provider);
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new SchemaError(provider, `${provider} returned an invalid reply`);
  if (payload.success !== true || payload.statusCode !== 200) throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  const bound = payload.data.filter((item: unknown) => isRecord(item) && typeof item.no === 'string'
    && normalizeTrackingNumber(item.no) === number) as Record<string, unknown>[];
  if (bound.length !== 1) throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  const item = bound[0]!;
  const error = itdidaText(item, 'errorMsg', provider, 200);
  if (error === ITDIDA_UNKNOWN) throw new NotFoundError(provider, `${provider} has no parcel under this number`);
  if (error) throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  const { detail, trackList: rows } = item;
  if (!isRecord(detail)) throw new SchemaError(provider, `${provider} returned a parcel without its waybill`);
  if (!Array.isArray(rows)) throw new SchemaError(provider, `${provider} returned a parcel with invalid scans`);
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  return { detail, rows };
}

/** The destination country the waybill names, as an ISO code. */
export function itdidaDestination(parcel: ItdidaParcel, provider: string): string | null {
  return itdidaCountry(itdidaText(parcel.detail, 'guoJia', provider, 60));
}

/** The number the onward carrier delivers under, when the waybill names one apart from its own. */
export function itdidaOnward(parcel: ItdidaParcel, number: string, provider: string): string | null {
  const onward = normalizeTrackingNumber(itdidaText(parcel.detail, 'zhuanDanHao', provider, 64));
  return ONWARD.test(onward) && onward !== number ? onward : null;
}

/** A scan's wall clock to the second, and its instant when the scan states a valid offset. */
function clock(row: Record<string, unknown>, provider: string): { local: string; instant?: string } {
  const match = CLOCK.exec(itdidaText(row, 'time', provider, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; Luxon rolls 24:00:00 over, so only a clock that reads back unchanged is kept.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  const offset = itdidaText(row, 'timezone', provider, 40);
  const instant = OFFSET.test(offset) ? explicitOffsetTime(`${local}${offset}`) : null;
  return instant ? { local, instant: instant.iso } : { local };
}

/** A scan's place: the platform's own spelling of the field, else its city, province and country, without postcodes. */
function place(row: Record<string, unknown>, provider: string): string {
  const named = itdidaText(row, 'localtion', provider, 120)
    || ['eventCity', 'eventProvince', 'eventCountry'].map((key) => itdidaText(row, key, provider, 60)).filter(Boolean).join(', ');
  const location = clean(named.replace(POSTCODE_RUN, '$1'), 120).replace(/^[\s,;:]+|[\s,;:]+$/g, '');
  // A placeholder such as "--" names no place.
  return /[\p{L}\p{N}]/u.test(location) ? location : '';
}

/**
 * A parcel's scans, in the tracker's order, newest first. The platform gives
 * each scan a wall clock in the zone of its place, with the zone field blank on
 * every reply seen, so a scan keeps its wall clock unless it states an offset.
 * Scans from China, Hong Kong and the destination are listed by their wall
 * clocks. A row without wording says nothing, and a repeated one is read once.
 */
export function itdidaScans(rows: unknown[], provider: string, stage: (wording: string, code: string) => ClassifiedWording | null): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    const { local, instant } = clock(row, provider);
    const wording = itdidaText(row, 'desc', provider);
    const description = clean(/^delivered\b/i.test(wording) ? wording.replace(RECEIVER, '') : wording, 300);
    if (!description) continue;
    const location = place(row, provider);
    const code = itdidaText(row, 'eventCode', provider, 16);
    if (code && !CODE.test(code)) throw new SchemaError(provider, `${provider} returned an invalid scan code`);
    const key = JSON.stringify([instant ?? local, location, description, code]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = stage(description, code);
    events.push({
      ...(instant ? { time: instant } : { local_time: local }),
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(provider);
  return events;
}

/** A number of a tenant whose lookup takes its waybills, references and onward numbers alike. */
export function itdidaNumber(raw: string, provider: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} looks parcels up by 6 to 40 letters and digits`);
  return number;
}

/** A forwarder's tenant: where its lookup is, and how its numbers and scans read. */
export interface ItdidaTenant {
  readonly carrier: string;
  readonly provider: string;
  /** `<tenant>.itdida.com`, or the forwarder's own domain where it serves the platform's lookup. */
  readonly host: string;
  /** The whole number asked; a number the tenant does not issue is invalid input. */
  readonly normalize: (raw: string) => string;
  /** A scan's stage by its wording and code, or null. */
  readonly stage: (wording: string, code: string) => ClassifiedWording | null;
  readonly statusMap: CarrierStatusMap;
  /** The rows the scans are read from, for a tenant whose reply lists rows that are no scan or fills a place with something else. */
  readonly rows?: (rows: unknown[]) => unknown[];
}

/**
 * A tenant's reply to its `queryTracks` lookup. The waybill names its
 * destination and, once handed on, the onward carrier's number.
 */
export function parseItdida(tenant: ItdidaTenant, payload: unknown, raw: string): CarrierResult {
  const number = tenant.normalize(raw);
  const parcel = itdidaEntry(payload, number, tenant.provider);
  const events = itdidaScans(tenant.rows ? tenant.rows(parcel.rows) : parcel.rows, tenant.provider, tenant.stage);
  const latest = events[0]!;
  const staged = leadingScan(events, tenant.statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = itdidaDestination(parcel, tenant.provider);
  const onward = itdidaOnward(parcel, number, tenant.provider);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(onward ? { delivery_tracking_number: onward } : {}),
    events,
  };
}

export interface ItdidaOptions { readonly fetcher?: typeof fetch; readonly recorder?: StepRecorder; readonly userAgent?: string }

/** A tenant's guest lookup: the number alone, with no session, token or key. */
export class ItdidaTracker {
  constructor(private readonly tenant: ItdidaTenant, private readonly options: ItdidaOptions = {}) {}

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const { tenant } = this;
    const number = tenant.normalize(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const { response, bytes } = await fetchBounded(itdidaLookupUrl(tenant.host, number), { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: tenant.provider, fetcher: this.options.fetcher, maxBytes: ITDIDA_MAX_BYTES,
        timeoutMs: Math.max(1, Math.floor(timeoutMs)), redirect: 'manual', allowHttpStatuses: [...ITDIDA_REDIRECTS, 404, 410, ITDIDA_BUSY] });
      // A busy tenant answers 503 in JSON, read as a rate limit; a 503 without it is maintenance.
      if (response.status === ITDIDA_BUSY) itdidaUnavailable(decodeText(bytes), tenant.provider);
      // An unknown number is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(tenant.provider, `${tenant.provider} tracking lookup is unavailable`, { status: response.status });
      return parseItdida(tenant, itdidaJson(decodeText(bytes), tenant.provider), number);
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

/** A tenant's adapter: the lookup, which recognition asks too. */
export function itdidaAdapter(tenant: ItdidaTenant): AdapterFactory {
  return (environment) => {
    const tracker = new ItdidaTracker(tenant, { fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
    return {
      id: tenant.carrier, recordsSteps: true, steps: ['direct', 'retry'],
      track: (input, context) => tracker.fetch(input.number, context),
      recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context), () => accepted(() => tenant.normalize(number))),
    };
  };
}
