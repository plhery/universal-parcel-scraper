import { load } from 'cheerio';
import { accepted, recognizeFromLookup, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
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
import { countryCode, countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';
import { isRecord } from '../../core/types.js';
import { locatePlace, placeTimeZone } from '../../places/index.js';

// The T6 platform (T6国际物流专线管理系统, t6soft.com) Chinese freight lines run their
// tracking on. Each line has its own host, `<tenant>.t6soft.com`; the guest lookup and
// its replies are the same on every one: a search for the number, then the timeline of
// the waybill it found.

/** The clock of the platform and of the lines on it, which work from China. */
export const T6_ZONE = 'Asia/Shanghai';
// The fields the tracking page searches the number in: the platform's own number, the
// shipper's reference, the waybill, the onward and replaced onward numbers, and the FBA shipment.
const NUMBER_FIELDS = ['systemnumber', 'customernumber1', 'waybillnumber', 'tracknumber', 'newtracknumber', 'fbanumber'] as const;
/** The fields a number found under several waybills must match for one of them to be the parcel asked. */
const OWN_FIELDS = ['customernumber1', 'waybillnumber'] as const;
const SEARCH_FIELDS = NUMBER_FIELDS.map((field) => `border.${field}`).join(',');
// A search answers a few hundred bytes per waybill, and a timeline page a few dozen kilobytes.
const LIST_MAX_BYTES = 256 * 1024;
const ITEM_MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 200;
const MAX_ROWS = 500;
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
const NUMBER = /^[A-Z0-9]{6,40}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A place in the platform's brackets: 【NEW YORK,NY,US】.
const BRACKETED = /^【(.*)】$/s;
// Four to six digits standing alone in a place are a postcode.
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])\d{4,6}(?![\p{L}\p{N}])/gu;
// An Amazon FBA shipment id, which a line delivering to Amazon can write into a row.
const FBA_ID = /(^|[^A-Z0-9])FBA[0-9A-Z]{8,10}(?![A-Z0-9])/gi;
// Who took a delivered parcel, as a row can name them.
const RECEIVER = /\s*[,，;；]?\s*(?:[签簽]收人|\b(?:signed(?:\s+for)?\s+by|received\s+by|signatory)\b).*$/i;
// A zone that dates a row more than this after the read is not its clock.
const AHEAD_MS = 10 * 60_000;

export interface T6Tenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors and telemetry give. */
  readonly provider: string;
  /** The tenant's origin, as `https://tbwl.t6soft.com`. */
  readonly origin: string;
  /** A row's stage from its wording, or null to leave it open. */
  readonly stage: (wording: string) => ClassifiedWording | null;
  /** The tenant's status map, which passes over the notices it lists without a stage. */
  readonly statusMap: CarrierStatusMap;
}

/** A number the tenant may hold, without spaces or hyphens. Anything else is not one its search finds. */
export function normalizeT6Number(raw: string, provider: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} numbers are six to forty letters and digits`);
  return number;
}

/** The tracking page's search for one number, exact rather than fuzzy, in every number field. */
export function t6ListForm(number: string): URLSearchParams {
  return new URLSearchParams({ 'searchList.waybillnumber': number, 'searchListField.waybillnumber': SEARCH_FIELDS, searchLang: 'zh' });
}

/** The tracking page's request for a waybill's timeline. */
export function t6ItemForm(entry: T6Entry): URLSearchParams {
  return new URLSearchParams({ orderpkid: String(entry.pkid), waybillnumber: entry.waybill, searchLang: 'zh' });
}

/** The waybill a search found for the number asked. */
export interface T6Entry {
  /** The platform's record id, which the timeline request names. */
  readonly pkid: number;
  readonly waybill: string;
  /** The destination country's ISO code. */
  readonly country: string | null;
  /** The delivery postcode and FBA shipment id, kept out of the rows. */
  readonly withheld: readonly string[];
}

/** A number field of a waybill, normalized; a field that holds no text or integer is a changed reply. */
function numberField(row: Record<string, unknown>, key: string, provider: string): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return normalizeTrackingNumber(clean(value, 80));
}

/** An optional text field; anything but a string is a changed reply. */
function textField(row: Record<string, unknown>, key: string, provider: string, maxLength: number): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
function json(body: string, provider: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`, { cause });
    throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
  }
}

/**
 * The waybill a `trackList` search found for the whole number asked. A number the tenant
 * holds nothing under is `{"code":0,"data":[],"count":0}`, which is not found. The number
 * must be one of the waybill's six number fields; a number several waybills carry, such as
 * an FBA shipment's, must be the shipper's reference or the waybill of exactly one of them.
 */
export function t6Entry(payload: unknown, number: string, provider: string): T6Entry {
  // Another code is the platform's message for a search it did not run, which the page shows as it is.
  if (isRecord(payload) && typeof payload.code === 'number' && payload.code !== 0) {
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  if (!isRecord(payload) || payload.code !== 0 || !Array.isArray(payload.data)) throw new SchemaError(provider, `${provider} returned an invalid reply`);
  if (payload.data.length === 0) {
    if (payload.count === 0) throw new NotFoundError(provider, `${provider} has no parcel under this number`);
    throw new SchemaError(provider, `${provider} returned an invalid reply`);
  }
  if (payload.data.length > MAX_ENTRIES) throw new SchemaError(provider, `${provider} returned an oversized answer`);
  const rows = payload.data.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(provider, `${provider} returned an invalid waybill`);
    return row;
  });
  const bound = rows.filter((row) => NUMBER_FIELDS.some((key) => numberField(row, key, provider) === number));
  const own = bound.length > 1 ? bound.filter((row) => OWN_FIELDS.some((key) => numberField(row, key, provider) === number)) : bound;
  if (!bound.length) throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  if (own.length !== 1) throw new SchemaError(provider, `${provider} answered several waybills for the number asked`);
  const row = own[0]!;
  const { pkid } = row;
  const waybill = numberField(row, 'waybillnumber', provider);
  if (typeof pkid !== 'number' || !Number.isSafeInteger(pkid) || pkid <= 0 || !NUMBER.test(waybill)) {
    throw new SchemaError(provider, `${provider} returned a waybill without its record`);
  }
  const withheld = [textField(row, 'zipcode', provider, 20), textField(row, 'fbanumber', provider, 40)].filter((value) => value.length >= 3);
  return { pkid, waybill, country: countryCode(textField(row, 'countrycode', provider, 8)), withheld };
}

/** One timeline row as the page gives it. */
export interface T6Row { readonly clock: string; readonly location: string; readonly wording: string }

/**
 * The timeline rows of a `trackItem` page, which must be the waybill's. The milestone strip
 * above the timeline repeats some rows' times and is not read.
 */
export function t6Rows(html: string, waybill: string, provider: string): T6Row[] {
  const $ = load(html);
  const detail = $('div.t6-track-detail');
  if (detail.length !== 1) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a browser check`);
    throw new SchemaError(provider, `${provider} returned a page without the waybill's timeline`);
  }
  const id = detail.attr('id') ?? '';
  if (!id.startsWith('track-item-data-') || normalizeTrackingNumber(id.slice('track-item-data-'.length)) !== waybill) {
    throw new SchemaError(provider, `${provider} did not answer for the parcel asked`);
  }
  const items = detail.find('ul.layui-timeline > li.trackitem');
  if (items.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  return items.toArray().map((item) => {
    const field = (name: string, maxLength: number) => clean($(item).find(`span.${name}`).first().text(), maxLength);
    return { clock: field('trackdate', 40), location: field('tracklocation', 200), wording: field('trackinfo', 500) };
  });
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(clock: string, provider: string): string {
  const match = CLOCK.exec(clock);
  const local = match ? `${match[1]}T${match[2]!.length === 5 ? `${match[2]}:00` : match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  return local;
}

/** Text with the withheld values taken out, and the brackets or separators they leave behind. */
function withhold(text: string, withheld: readonly string[]): string {
  let kept = text.replace(FBA_ID, '$1');
  for (const value of withheld) kept = kept.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, 'giu'), '$1');
  return clean(kept.replace(/[(（[【]\s*[)）\]】]/g, ''), 500).replace(/^[\s,，;；:：]+|[\s,，;；:：]+$/g, '');
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A row's place without the platform's brackets, its parts set apart by a comma and a space, and without postcodes. */
function place(location: string, withheld: readonly string[]): string {
  const bare = BRACKETED.exec(location)?.[1] ?? location;
  const parts = withhold(bare.replace(POSTCODE_RUN, '$1'), withheld).split(/\s*[,，]\s*/).filter((part) => /[\p{L}\p{N}]/u.test(part));
  return clean(parts.join(', '), 120);
}

/**
 * The zone of a row's place: its town's or state's, or its country's where that keeps one
 * clock; null in a country of several named alone, or a place the gazetteer does not find.
 */
function placeZone(location: string): string | null {
  const found = locatePlace(location);
  if (!found) return null;
  return found.precision === 'country' && !found.region ? countryTimeZone(found.country) : placeTimeZone(found);
}

/**
 * A row dated on its place's clock, or on the platform's when it names no place. The rows give
 * no zone. Those of a parcel to New York read as a working day there: its container picked up,
 * unloaded and sorted over an afternoon, its truck out and delivered in a morning; on Beijing's
 * clock all of it would have happened at night. A zone that would date the row after the read
 * is not its clock, so the row keeps its wall clock alone, as it does where no zone is known.
 */
function dated(local: string, location: string, readAt: number): Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> {
  const zone = location ? placeZone(location) : T6_ZONE;
  const time = zone ? isoTime(local, zone) : null;
  if (!zone || !time || time.timestamp > readAt + AHEAD_MS) return {};
  return { time: time.iso, time_zone: zone, time_zone_basis: location ? 'place' : 'carrier' };
}

/**
 * A waybill's timeline, newest first as the page lists it. Each row keeps its wall clock in
 * `local_time`, with the instant its place's zone gives it. A row without wording says nothing,
 * and a repeated one is read once.
 */
export function t6Scans(rows: readonly T6Row[], entry: T6Entry, tenant: T6Tenant, readAt: number): CarrierEvent[] {
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const local = wallClock(row.clock, tenant.provider);
    const description = withhold(row.wording.replace(RECEIVER, ''), entry.withheld);
    if (!description) continue;
    const location = place(row.location, entry.withheld);
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = tenant.stage(description);
    events.push({ local_time: local, ...dated(local, location, readAt), ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  if (!events.length) throw new NoHistoryError(tenant.provider, `${tenant.provider} lists the waybill without a timeline`, { reason: 'listed' });
  return events;
}

/** The result of a waybill's search entry and its timeline page. */
export function parseT6(list: unknown, html: string, raw: string, tenant: T6Tenant, readAt = Date.now()): CarrierResult {
  const number = normalizeT6Number(raw, tenant.provider);
  const entry = t6Entry(list, number, tenant.provider);
  const events = t6Scans(t6Rows(html, entry.waybill, tenant.provider), entry, tenant, readAt);
  const latest = events[0]!;
  const staged = leadingScan(events, tenant.statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.time ? {} : { last_update_local: latest.local_time }),
    expected_delivery: null,
    ...(entry.country ? { destination_country: entry.country } : {}),
    events,
  };
}

/** One lookup on a tenant's tracker, sent once more after a network failure. */
export class T6Tracker {
  constructor(private readonly tenant: T6Tenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** A form POST to one of the tracking page's endpoints, and the reply's text. */
  private async post(path: string, form: URLSearchParams, accept: string, maxBytes: number, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(new URL(path, this.tenant.origin), { method: 'POST', signal, headers: {
      Accept: accept, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: form }, { provider, fetcher: this.options.fetcher, maxBytes, timeoutMs, redirect: 'manual',
      allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    if (response.status === 429) throw new RateLimitedError(provider, retryAfterMs(response.headers.get('retry-after')));
    // A redirect leads to the login page or a moved route; either way the lookup is not there.
    if (response.status !== 200) throw new TransportError(provider, `${provider} tracking lookup is unavailable`, { status: response.status });
    return decodeText(bytes);
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeT6Number(raw, this.tenant.provider);
    // The search first, then the timeline of the waybill it found, inside one attempt's time.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      const list = json(await this.post('/trackList', t6ListForm(number), 'application/json, text/javascript, */*; q=0.01',
        LIST_MAX_BYTES, signal, left()), this.tenant.provider);
      const entry = t6Entry(list, number, this.tenant.provider);
      const html = await this.post('/trackItem', t6ItemForm(entry), 'text/html, */*; q=0.01', ITEM_MAX_BYTES, signal, left());
      return parseT6(list, html, number, this.tenant, Date.now());
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }

  /** Whether the tenant holds the number: a waybill without a timeline is held. */
  recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    return recognizeFromLookup(() => this.fetch(raw, context), () => accepted(() => normalizeT6Number(raw, this.tenant.provider)));
  }
}
