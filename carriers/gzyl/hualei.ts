/**
 * The Hualei (华磊) forwarder platform, which GZYL, Tianhui Hengyuan, JRT,
 * Meiteshun, Mayi Yinfu and BYHD each run as a tenant: a Tomcat tracker on port 8082
 * of a bare IP or the carrier's own domain, most over plain HTTP only. `selectTrack.htm` is the platform's documented track
 * interface, JSON encoded in GBK; `trackIndex.htm` is the tracking page the
 * carriers' sites open, in HTML. Each carrier keeps its own host and status
 * map; this module holds the requests and parsers they share.
 */
import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { accepted, recognizeFromLookup, type Recognition, type TrackingContext } from '../../core/adapter/index.js';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { brandCarrierIds, carrierBrand, carrierIdFromName } from '../../core/catalog/hints.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError, TransportError,
} from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvent, plannedEvents, type PlannedEvent } from '../../core/result/planned.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import type { CarrierId } from '../../generated/catalog.js';
import { hualeiServiceName } from './service.js';
import { hualeiPlace, hualeiScanText, hualeiWording } from './text.js';
import { retryAfterMs } from '../../core/transport/retryAfter.js';

export { hualeiScanText };

/** One carrier's tenant on the platform. */
export interface HualeiTenant {
  /** The catalog id. */
  readonly carrier: string;
  /** The name errors carry. */
  readonly provider: string;
  /** The tracker's origin, `http://<address>:8082`, or the HTTPS host of a tenant that has one. */
  readonly origin: string;
  /** The stage the carrier's map gives a row, by its kind code (null without one) and `normalizeStatusWording` wording. */
  readonly stage: (code: string | null, wording: string) => Stage | undefined;
  /**
   * The English a row the tenant words only in Chinese is shown in, by the same
   * code and wording, or by the wording as the tracker writes it (`shown`).
   * The stage still comes from the tenant's own wording.
   */
  readonly english?: (code: string | null, wording: string, shown: string) => string | undefined;
  /** The wording and place of a row whose text carries both, before the shared cleaning. */
  readonly split?: (content: string, location: string) => { readonly content: string; readonly location: string };
  /** Rows keep their wall clocks: some rows the tracker copies from another carrier come on that carrier's clock. */
  readonly wallClocks?: true;
  /**
   * How a row's clock reads where the record settles it row by row: on the
   * platform's clock, as a wall clock, as its day alone, or as a wall clock on a
   * zone the tenant knows, given the record's rows. It takes the place of `wallClocks`.
   */
  readonly clock?: (row: HualeiRow, rows: readonly HualeiRow[]) => 'platform' | 'wall' | 'day' | HualeiZoneClock;
  /**
   * Whether a row's wording repeats another's, in the same minute, place and
   * kind, with more around it: the row then counts once, as the other. Two rows
   * that repeat each other are one row written twice: the one the reply lists
   * last, its first record, stays.
   */
  readonly repeats?: (wording: string, other: string) => boolean;
  /**
   * Carriers the tenant hands records to without naming a channel: one takes a
   * record whose transfer number, or else invoice number, its own high-confidence
   * rule claims whole, under a channel label too unless the label names another
   * carrier. Wokexp's line to Italy gives Poste Italiane's number as the invoice
   * number alone.
   */
  readonly unlabelledPartners?: readonly CarrierId[];
  /**
   * The carrier whose scans the tenant's line copies into a record whose tracking
   * number is that carrier's waybill, of a shape no rule ties to it with high
   * confidence, as iMile's thirteen digits on HJYT's and Qyun's lines: the carrier
   * takes the record when its own detection offers the tracking number, it serves
   * the destination, a row is one of its copies (`copies`) and no channel names
   * another carrier.
   */
  readonly copiedPartner?: { readonly carrier: CarrierId; readonly copies: (row: HualeiRow) => boolean };
  /**
   * Carriers a product name names, as JRT's line to Ireland names FedEx: on a
   * record of that product without a channel, the delivery carrier's number is
   * the named carrier's when it takes the number.
   */
  readonly productPartners?: readonly (readonly [RegExp, CarrierId])[];
  /**
   * The tracking page finds an order by the tenant's own number without showing
   * it, only the delivery carrier's number and the shipper's reference: a lone
   * record then answers the one number the page's form echoes back, and the
   * tracking number it shows is the delivery carrier's.
   */
  readonly pageEcho?: true;
  /**
   * The tracking page answers a number it holds no order for with its bare search form, as its
   * index shows it: no waybill, and the number not echoed back. Asked only after the interface's
   * no-row answer for the number, that page settles not-found.
   */
  readonly bareUnknownPage?: true;
  /**
   * The tenant's own numbers. Once the delivery carrier's number has taken
   * `trackingNumber`, the track interface still finds an order by its own
   * number but returns it in no field: a lone record that holds none of the
   * number then answers it, unless its tracking number is another of the
   * tenant's own, and so does a lone waybill on the page whose form echoes the
   * number alone. A tracking number of another shape is the delivery carrier's.
   */
  readonly ownNumber?: RegExp;
  /**
   * The track interface also finds an order by its delivery carrier's number, which it returns in no
   * field: a lone record that holds none of the number answers it when its tracking number is one of
   * the tenant's own (`ownNumber`) and the number is the one the record's delivery carrier would take
   * as a hand-off, from `unlabelledPartners`. That carrier then delivers the parcel under the number.
   */
  readonly partnerNumbers?: true;
  /**
   * The tenant's scripts end in a delivery row the platform writes on its own day, in an evening
   * batch, rather than ahead: on a record with rows written ahead, a delivery row is the script's
   * too, and is held back and named with them. The page shows no creation times, so a delivery
   * row it shows is held back too.
   */
  readonly scriptedDelivery?: true;
  /**
   * The tenant writes a record's whole feed at once, on Beijing's clock, as a script (`ONE_BATCH_SCRIPTS`): in a
   * second in which the platform wrote a row more than half an hour before its own clock, every row but the
   * order's registration is the script's, however soon its clock.
   */
  readonly oneBatch?: true;
  /**
   * The code of the tenant's origin warehouse departure. The parcel leaves it before any delivery,
   * so such a row dated a day or more after a delivery row is a stray written late, not movement,
   * and goes.
   */
  readonly departure?: string;
  /**
   * The number a row's wording says the parcel goes on under, as BYT's "the new tracking number
   * is …": on a record that holds no delivery carrier's number, the newest such row gives it, and a
   * carrier in `unlabelledPartners` takes it when its own high-confidence rule claims it whole.
   */
  readonly handOff?: (content: string) => string | undefined;
  /**
   * Whether a row, by its kind code (null without one) and `normalizeStatusWording` wording, is a notice
   * rather than a movement, such as the flight booked for the parcel before it flies: it keeps the stage of
   * the scan before it, with no source of its own, and decides no status.
   */
  readonly notice?: (code: string | null, wording: string) => boolean;
  /**
   * The tenant copies a partner's rows in a language whose letters GBK cannot hold, as Posti's
   * Finnish ä and ö: a question mark between two letters is such a letter, kept as the track
   * interface gives it, not a space GBK lost.
   */
  readonly lostLetters?: true;
}

/**
 * The zone of the trackers' own clock: it decides when a row written ahead is
 * shown, and a tenant's rows are read on it, abroad too, unless the tenant keeps
 * their wall clocks (`wallClocks`, `clock`).
 */
export const HUALEI_ZONE = 'Asia/Shanghai';
export const HUALEI_TRACK_PATH = '/selectTrack.htm';
export const HUALEI_PAGE_PATH = '/trackIndex.htm';
// A record is a few kilobytes, a page a few dozen.
const TRACK_MAX_BYTES = 512 * 1024;
const PAGE_MAX_BYTES = 1024 * 1024;
const MAX_RECORDS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// The service matches a number or reference exactly as written, dashes included, so a caller
// that strips dashes, as `normalizeTrackingNumber` does, loses a dashed reference. A comma would
// ask for several.
const NUMBER = /^(?=.{6,40}$)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A tenant that keeps wall clocks can date a row on its destination's clock, up to six hours
// ahead of Beijing's, the clock rows are written on: a row written more than twelve hours before
// its own clock was written ahead, on every tenant. A row written in the same second as such a
// row is the same script's when it was written more than six hours before its own clock, on
// whichever clock it is read. On Beijing's clock no destination's lead applies: there the six
// hours keep the rows a script dates within hours of its writing, GZYL's order row and
// Meiteshun's collection, which a shorter margin would hold back with the rest. A tenant whose
// whole feed is the script (`oneBatch`) keeps only the order's registration from it: half an hour
// ahead of its writing is enough to tell its second from a scan's.
const WRITTEN_AHEAD_MS = 12 * 3_600_000;
const SCRIPT_BATCH_MS = 6 * 3_600_000;
const ONE_BATCH_LEAD_MS = 30 * 60_000;
// The kind of the rows the platform's custom track product (轨迹定制) writes to a script: they
// can have a parcel abroad before it reaches the airport.
const CUSTOM_TRACK = 'CO_C_CR';
// The service's answer when it holds no row for the number: an unknown number,
// or an order whose rows the interface does not list. Only the page tells which.
const NO_TRACK = '未查询到轨迹';
const REDIRECTS = [301, 302, 303, 307, 308];
const GONE = [404, 410];
// Bot checks a firewall or cloud host could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|The requested URL was rejected|<title>\s*(?:滑动验证|验证码|安全验证|访问受限)/i;
// The record's own numbers: tracking number, the shipper's reference, the waybill code and the channel's transfer number.
const IDENTITY_FIELDS = ['trackingNumber', 'referenceNumber', 'business_seqinvoicecode', 'business_channeltransfercode'] as const;
// The page's columns that carry those numbers. The recipient's column is never read.
const PAGE_IDENTITY_COLUMNS = ['参考号', '跟踪号码', '渠道转单号'] as const;
const PAGE_OWN_COLUMNS = ['跟踪号码', '渠道转单号'] as const;
const RECIPIENT_COLUMN = '收件人';
// The track interface replies in GBK: a partner's row in a script GBK cannot hold, as Israel Post's
// Hebrew, comes with each of its letters a question mark, and only question marks, spaces and
// punctuation are left of its wording or place. The tracking page is UTF-8 and shows it whole.
const LOST_TO_GBK = /^(?=[^?]*\?)[\s\p{P}\p{S}]*$/u;

/** Whether a row's wording or place reached the track interface with only question marks, spaces and punctuation left of it. */
export const hualeiLostToGbk = (value: string): boolean => LOST_TO_GBK.test(value);

/**
 * Delivery carriers by the channel label a record names in `channel_name`, in
 * `normalizeStatusWording` form. A label the table does not hold names no
 * partner. The labels are Swiss Post's, where GZYL's, Tianhui Hengyuan's and
 * JRT's lines end.
 */
const PARTNERS: Readonly<Record<string, CarrierId>> = {
  'swiss post': 'swiss-post',
  swisspost: 'swiss-post',
  'post ch': 'swiss-post',
  瑞士邮政: 'swiss-post',
};

/**
 * The delivery carrier a record's channel label names, when the table holds the
 * label, that carrier's own detection offers the number and it serves the
 * destination.
 */
export function hualeiPartner(label: string, number: string, destination = ''): CarrierId | undefined {
  const key = normalizeStatusWording(label);
  const carrier = Object.hasOwn(PARTNERS, key) ? PARTNERS[key] : undefined;
  return carrier && takes(carrier, number, destination) ? carrier : undefined;
}

/** Whether a carrier's own detection offers the number and it serves the destination; a carrier listing no country serves all. */
function takes(carrier: CarrierId, number: string, destination: string): boolean {
  if (!/^[A-Z0-9]{4,40}$/.test(number)) return false;
  if (!(detectCarrierMatch(number).candidates as string[]).includes(carrier)) return false;
  const countries: readonly string[] = CARRIER_DEFINITIONS[carrier]?.countries ?? [];
  return !destination || !countries.length || countries.includes(destination);
}

/** A number or reference the tracker can be asked for, upper case; anything else is never sent. */
export function normalizeHualeiNumber(raw: string, provider: string): string {
  const number = raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(provider, `${provider} looks parcels up by 6 to 40 letters, digits and dashes`);
  return number;
}

/** A number as identities are compared: the tracker's own numbers can carry dashes. */
const identity = (value: string) => value.toUpperCase().replace(/[\s-]+/g, '');

/** A number's shape with none of its characters: its runs of letters, digits and other signs counted, as "A3D10A2". */
const numberShape = (value: string) => (identity(value).match(/[A-Z]+|\d+|[^A-Z\d]+/g) ?? [])
  .map((run) => `${/^[A-Z]/.test(run) ? 'A' : /^\d/.test(run) ? 'D' : 'X'}${run.length}`).join('');

/** The address of the track interface for one number. */
export function hualeiTrackUrl(tenant: HualeiTenant, raw: string): string {
  const url = new URL(HUALEI_TRACK_PATH, tenant.origin);
  url.searchParams.set('documentCode', normalizeHualeiNumber(raw, tenant.provider));
  return url.toString();
}

/** An optional text field; anything but a string is a changed reply. */
function text(record: JsonObject, key: string, provider: string, maxLength = 500): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(provider, `${provider} returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A row's wall clock, `yyyy-MM-ddTHH:mm:ss`. */
function wallClock(value: string, provider: string): string {
  const match = CLOCK.exec(value);
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = local ? DateTime.fromISO(local, { zone: 'UTC' }) : null;
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(provider, `${provider} returned an invalid scan time`);
  }
  return local;
}


/**
 * One row as the reply gives it: its wall clock, text, place and kind code, and
 * the platform's clock when it was written, which only the track interface gives.
 */
export interface HualeiRow {
  readonly clock: string; readonly content: string; readonly location: string; readonly code: string; readonly written?: string;
}

/**
 * A wall clock on a zone the tenant knows, and how that zone was chosen (`time_zone_basis`). `misread` marks
 * a partner's wall clock on `misread.zone` that the tenant took for one on `misread.as` before writing it on
 * Beijing's: the row's clock put back on `misread.as` gives the partner's, and the instant is shown on `zone`.
 */
export interface HualeiZoneClock {
  readonly zone: string; readonly basis: 'destination' | 'carrier'; readonly misread?: { readonly zone: string; readonly as: string };
}

/** A row's time on a zone clock, and its wall clock there: the row's own, or the partner's a misread one stands for. */
function zonedTime(local: string, platform: string, clock: HualeiZoneClock): { iso: string; wall: string } | undefined {
  if (!clock.misread) {
    const iso = isoTime(local, clock.zone)?.iso;
    return iso ? { iso, wall: local } : undefined;
  }
  const partner = DateTime.fromISO(platform, { setZone: true }).setZone(clock.misread.as).toFormat("yyyy-LL-dd'T'HH:mm:ss");
  const instant = isoTime(partner, clock.misread.zone);
  const shown = instant ? DateTime.fromMillis(instant.timestamp, { zone: clock.zone }) : undefined;
  return shown?.isValid ? { iso: shown.toISO({ suppressMilliseconds: true }), wall: shown.toFormat("yyyy-LL-dd'T'HH:mm:ss") } : undefined;
}

/** When the platform wrote a row, on its own clock, which only the track interface says. */
function writtenAt(row: HualeiRow): string | undefined {
  const match = CLOCK.exec(row.written ?? '');
  return match ? isoTime(`${match[1]}T${match[2]}`, HUALEI_ZONE)?.iso : undefined;
}

/** Whether a row was written more than `lead` before its own clock. */
function writtenAhead(row: HualeiRow, local: string, lead = WRITTEN_AHEAD_MS): boolean {
  const match = CLOCK.exec(row.written ?? '');
  if (!match) return false;
  const written = DateTime.fromISO(`${match[1]}T${match[2]}`, { zone: 'UTC' });
  return written.isValid && written.toMillis() + lead < DateTime.fromISO(local, { zone: 'UTC' }).toMillis();
}

/**
 * Whether each row is part of a timeline written ahead: written more than twelve hours before its
 * own clock, or in the same second as such a row and more than six hours before its own clock.
 */
function forecasts(rows: readonly HualeiRow[], clocks: readonly string[]): boolean[] {
  const script = new Set(rows.filter((row, index) => writtenAhead(row, clocks[index]!)).map((row) => row.written));
  return rows.map((row, index) => writtenAhead(row, clocks[index]!)
    || script.has(row.written) && writtenAhead(row, clocks[index]!, SCRIPT_BATCH_MS));
}

/**
 * The same for a tenant whose whole feed is the script (`oneBatch`): a row written more than twelve
 * hours before its own clock, or in a second in which a row was written more than half an hour before
 * its own, unless it registers the order.
 */
function oneBatchForecasts(rows: readonly HualeiRow[], clocks: readonly string[], registrations: readonly boolean[]): boolean[] {
  const script = new Set(rows.filter((row, index) => writtenAhead(row, clocks[index]!, ONE_BATCH_LEAD_MS)).map((row) => row.written));
  return rows.map((row, index) => writtenAhead(row, clocks[index]!) || !registrations[index] && script.has(row.written));
}

function stageOf(tenant: HualeiTenant, code: string, description: string): { stage: Stage; source: string } | undefined {
  const mapped = tenant.stage(code || null, normalizeStatusWording(description));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(description, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, source: worded.source };
}

/**
 * The rows as scans, newest first. Tenants write whole timelines ahead, from
 * the collection to the delivery: a row written well before its own clock is
 * a forecast, not a scan, and so are a row of the custom track product and a
 * row dated after the lookup on the trackers' clock. So is the delivery row of
 * a tenant whose scripts end in one written on its day, on a record with rows
 * written ahead or on the page, which shows no creation times. Identical rows count
 * once, and so do rows the tenant says repeat another. A row the tenant has
 * English for is staged and deduplicated by its own wording, then shown in
 * English. `ahead` lists the clocks of the rows held back as written ahead
 * and of the custom track's, as the tenant reads them, and `planned` those
 * rows as steps at the same clocks, the earliest first.
 */
function scans(rows: readonly HualeiRow[], tenant: HualeiTenant, readAt: number, page: boolean): {
  events: CarrierEvent[]; truncated: boolean; ahead: string[]; planned: PlannedEvent[];
} {
  const seen = new Set<string>();
  const ahead = new Set<string>();
  const held: { clock: string; index: number; step: PlannedEvent }[] = [];
  const kept: { clock: string; index: number; event: CarrierEvent; english?: string; notice: boolean }[] = [];
  const clocks = rows.map((row) => wallClock(row.clock, tenant.provider));
  const read = rows.map((row) => {
    const parts = tenant.split?.(row.content, row.location) ?? row;
    const place = hualeiPlace(parts.location, tenant);
    const wording = hualeiWording(parts.content, parts.location, tenant);
    const description = wording || place;
    const notice = description !== '' && tenant.notice?.(row.code || null, normalizeStatusWording(description)) === true;
    return { wording, description, location: wording ? place : '', notice,
      staged: description && !notice ? stageOf(tenant, row.code, description) : undefined };
  });
  const forecast = tenant.oneBatch
    ? oneBatchForecasts(rows, clocks, read.map(({ staged }) => staged?.stage === 'registered')) : forecasts(rows, clocks);
  // The page shows no creation times, so it cannot tell a script's delivery row from a scan: there
  // every delivery row of such a tenant is held back, as the track interface holds a script's.
  const scripted = tenant.scriptedDelivery === true && (page || forecast.some(Boolean));
  rows.forEach((row, index) => {
    const local = clocks[index]!;
    const placed = isoTime(local, HUALEI_ZONE)!;
    const reading = tenant.clock?.(row, rows) ?? (tenant.wallClocks ? 'wall' : 'platform');
    const zoned = typeof reading === 'object' ? zonedTime(local, placed.iso, reading) : undefined;
    // A misread clock stands for an instant: the row is named and listed by it.
    const instant = reading === 'platform' ? placed.iso : typeof reading === 'object' && reading.misread ? zoned?.iso : undefined;
    const { wording, description, location, staged, notice } = read[index]!;
    const english = wording ? tenant.english?.(row.code || null, normalizeStatusWording(wording), wording) : undefined;
    // A row held back is named by its clock as the tenant reads it, and listed as a step at that same clock,
    // in the words a scan would show.
    const hold = () => {
      const clock = instant ?? local;
      ahead.add(clock);
      const step = plannedEvent({ ...(instant ? { time: clock } : { local_time: clock }), description: english ?? description,
        ...(location ? { location } : {}), ...(staged ? { stage: staged.stage } : {}) });
      if (step) held.push({ clock: local, index, step });
    };
    if (row.code === CUSTOM_TRACK || forecast[index]) {
      hold();
      return;
    }
    if (placed.timestamp > readAt) return;
    if (!description) return;
    const key = JSON.stringify([local, description, location, row.code]);
    if (seen.has(key)) return;
    seen.add(key);
    if (scripted && staged?.stage === 'delivered') {
      hold();
      return;
    }
    const written = writtenAt(row);
    kept.push({ clock: local, index, notice, ...(english ? { english } : {}), event: {
      ...(reading === 'platform' ? { time: placed.iso } : { local_time: reading === 'day' ? local.slice(0, 10) : zoned?.wall ?? local }),
      ...(zoned && typeof reading === 'object' ? { time: zoned.iso, time_zone: reading.zone, time_zone_basis: reading.basis } : {}), description,
      ...(location ? { location } : {}),
      ...(row.code ? { provider_code: row.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      // Kept with the scan, so that stored rows show which clock a row abroad is on.
      ...(written ? { written_at: written } : {}),
    } });
  });
  const { repeats } = tenant;
  // A repeat can come seconds apart: meso-global's DHL rows are to the minute, the destination post's to the second.
  const unrepeated = repeats ? kept.filter((entry) => !kept.some((other) => other !== entry && other.clock.slice(0, 16) === entry.clock.slice(0, 16)
    && other.event.location === entry.event.location && other.event.provider_code === entry.event.provider_code
    && repeats(entry.event.description!, other.event.description!)
    && (other.index > entry.index || !repeats(other.event.description!, entry.event.description!)))) : kept;
  // The platform can write a partner's row again, and a copy written after a European clock change
  // reads the partner's clock an hour off: meso-global's DHL rows written in October summer time at
  // 17:09 came again, written after the change, at 18:09. The copy written later goes.
  const copies = unrepeated.filter((entry) => !unrepeated.some((other) => other !== entry
    && other.event.description === entry.event.description && other.event.location === entry.event.location
    && other.event.provider_code === entry.event.provider_code && hourApart(other.clock, entry.clock)
    && Date.parse(entry.event.written_at ?? '') - Date.parse(other.event.written_at ?? '') >= 86_400_000));
  const deliveries = copies.filter(({ event }) => event.stage === 'delivered').map(({ clock }) => Date.parse(`${clock}Z`));
  const unique = tenant.departure ? copies.filter(({ clock, event }) => event.provider_code !== tenant.departure
    || !deliveries.some((at) => Date.parse(`${clock}Z`) - at >= 86_400_000)) : copies;
  // Rows come newest first; rows on one clock keep the reply's order.
  unique.sort((a, b) => (a.clock === b.clock ? a.index - b.index : a.clock < b.clock ? 1 : -1));
  const returns = returnStages(unique.map(({ event }) => event));
  const events = unique.map(({ event, english }, index) => ({ ...event, ...(english ? { description: english } : {}),
    ...(returns[index] ? { stage: returns[index] } : {}) }));
  // A notice takes the stage of the scan before it, with no source of its own.
  let before: Stage | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (unique[index]!.notice) {
      if (before) Object.assign(event, { stage: before, stage_source: 'none' });
    } else if (event.stage) before = event.stage as Stage;
  }
  // The steps held back, the earliest first, each once.
  held.sort((a, b) => (a.clock === b.clock ? b.index - a.index : a.clock < b.clock ? -1 : 1));
  return { events: events.slice(0, MAX_EVENTS), truncated: events.length > MAX_EVENTS, ahead: [...ahead],
    planned: plannedEvents(held.map(({ step }) => step)) };
}

/** Two wall clocks exactly an hour apart. */
const hourApart = (left: string, right: string): boolean => Math.abs(Date.parse(`${left}Z`) - Date.parse(`${right}Z`)) === 3_600_000;

const RETURN_LEG: ReadonlySet<string> = new Set(['in_transit', 'out_for_delivery', 'delivered']);

// A return the shipper received ends the way back: SXW Express's seller can send the parcel again
// under the same waybill, and the rows after it are that journey.
const BACK_WITH_SHIPPER = /\brec(?:ei|ie)ved by (?:the )?(?:shipper|sender)\b/i;

/**
 * The stage each scan, newest first, takes from a return before it. After a row the tenant's map
 * reads as returned, a move or a delivery is the parcel going, or delivered, back to the sender,
 * and is returned too, until the shipper has it. A return the shipper received with a scan after
 * it is the parcel held back at the origin and sent again: a problem on the way, not the parcel's
 * end, so that the app does not hold the return over the journey that follows. A return only the
 * shared wording rules read starts none.
 */
function returnStages(events: readonly CarrierEvent[]): Array<Stage | undefined> {
  const stages: Array<Stage | undefined> = events.map(() => undefined);
  let back = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const { stage, stage_source: source, description } = events[index]!;
    if (back && stage && RETURN_LEG.has(stage)) stages[index] = 'returned';
    else if (stage === 'returned' && source === 'carrier_map') {
      const withShipper = BACK_WITH_SHIPPER.test(description ?? '');
      back = !withShipper;
      if (withShipper && events.slice(0, index).some((later) => later.stage && later.stage !== 'pending')) stages[index] = 'exception';
    }
  }
  return stages;
}

interface Facts {
  readonly number: string;
  readonly tracking: string;
  readonly destination: string;
  readonly service?: string;
  readonly partner?: { readonly carrier: CarrierId; readonly number: string };
  /** The delivery carrier's number, its carrier unnamed. */
  readonly downstream?: string;
}

/**
 * The result. The record's own summary status is not read: it can be ahead
 * of the rows held back.
 */
function result(rows: readonly HualeiRow[], facts: Facts, tenant: HualeiTenant, readAt: number, page = false): CarrierResult {
  const { events, truncated, ahead, planned } = scans(rows, tenant, readAt, page);
  const { partner } = facts;
  const deliveryTrackingNumber = partner && partner.number !== identity(facts.number) ? partner.number
    : facts.downstream && facts.downstream !== identity(facts.number) ? facts.downstream : undefined;
  // The order exists, but nothing it holds is due yet. Rows written ahead are named, here and
  // beside the scans kept, so that a provider's copies of them are not taken for scans. A hand-over
  // goes with it: a tenant can set its own rows aside for the delivery carrier's, before that carrier scans.
  if (!events.length) {
    throw new NoHistoryError(tenant.provider, `${tenant.provider} has no scans for the shipment yet`, {
      ...(ahead.length ? { reason: 'written_ahead', writtenAhead: ahead } : { reason: 'listed' }),
      ...(planned.length ? { plannedEvents: planned } : {}),
      ...(partner ? { deliveryCarrier: partner.carrier } : {}), ...(deliveryTrackingNumber ? { deliveryTrackingNumber } : {}),
    });
  }
  const newest = events[0]!;
  // A note mapped as pending moves nothing: the newest row that moves the parcel leads it. A notice decides nothing.
  const decides = events.filter((event) => event.stage && event.stage_source !== 'none');
  const current = decides.find((event) => event.stage !== 'pending') ?? decides[0];
  const stage = current?.stage as Stage | undefined;
  // The tracking number is the order's own unless it is the delivery carrier's.
  const canonical = facts.tracking && identity(facts.tracking) !== identity(facts.number)
    && identity(facts.tracking) !== partner?.number ? facts.tracking : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null,
    ...(facts.service ? { service_name: facts.service } : {}),
    ...(/^[A-Z]{2}$/.test(facts.destination) ? { destination_country: facts.destination } : {}),
    ...(canonical ? { canonical_tracking_number: canonical } : {}),
    ...(partner ? { delivery_carrier: partner.carrier } : {}),
    ...(deliveryTrackingNumber ? { delivery_tracking_number: deliveryTrackingNumber } : {}),
    events,
    ...(truncated ? { history_truncated: true } : {}),
    ...(ahead.length ? { written_ahead: ahead } : {}),
    ...(planned.length ? { planned_events: planned } : {}),
  };
}

function trackRow(raw: unknown, provider: string): HualeiRow {
  if (!isRecord(raw)) throw new SchemaError(provider, `${provider} returned an invalid scan`);
  return {
    clock: text(raw, 'track_date', provider, 64), content: text(raw, 'track_content', provider),
    location: text(raw, 'track_location', provider, 200), code: text(raw, 'track_kind', provider, 64),
    // A creation time it cannot read is no evidence either way.
    written: typeof raw.track_createdate === 'string' ? clean(raw.track_createdate, 64) : '',
  };
}

/** Whether the page's text is the one the track interface gave: as long, and the same but where the interface has a question mark. */
function shownAs(given: string, shown: string): boolean {
  const left = [...given];
  const right = [...shown];
  return left.length === right.length && left.every((char, index) => char === '?' || char === right[index]);
}

/**
 * The rows, each one whose wording or place GBK lost taken from the page: the first page row not yet
 * taken on the same clock whose wording and place read as the interface's but where it has a question
 * mark. The page lists the rows in the interface's order. A row the page does not show whole stays as it came.
 */
function restoreLostRows(rows: readonly HualeiRow[], shown: readonly HualeiRow[]): HualeiRow[] {
  const taken = new Set<number>();
  return rows.map((row) => {
    if (!hualeiLostToGbk(row.content) && !hualeiLostToGbk(row.location)) return row;
    const index = shown.findIndex((other, at) => !taken.has(at) && other.clock === row.clock
      && !hualeiLostToGbk(other.content) && !hualeiLostToGbk(other.location)
      && shownAs(row.content, other.content) && shownAs(row.location, other.location));
    if (index < 0) return row;
    taken.add(index);
    return { ...row, content: shown[index]!.content, location: shown[index]!.location };
  });
}

/** Whether a row of the track interface's reply lost its wording or place to GBK. */
function losesText(payload: unknown): boolean {
  const reply: unknown = Array.isArray(payload) ? payload[0] : undefined;
  const records: readonly unknown[] = isRecord(reply) && Array.isArray(reply.data) ? reply.data : [];
  return records.some((record) => isRecord(record) && Array.isArray(record.trackDetails)
    && (record.trackDetails as unknown[]).some((row) => isRecord(row) && [row.track_content, row.track_location]
      .some((value) => typeof value === 'string' && hualeiLostToGbk(clean(value)))));
}

/** The first number whose own high-confidence rule names a carrier the tenant hands to without naming it. */
function unlabelledPartner(numbers: readonly string[], tenant: HualeiTenant): Facts['partner'] {
  for (const number of numbers) {
    const detected = number ? detectCarrierMatch(number) : undefined;
    const carrier = detected?.confidence === 'high' ? detected.carrier : undefined;
    if (carrier && tenant.unlabelledPartners?.includes(carrier)) return { carrier, number };
  }
  return undefined;
}

/**
 * The carrier whose scans the record copies under its waybill, the tracking number: its own detection
 * offers the number, it serves the destination, a row is one of its copies and no channel names another carrier.
 */
function copiedPartner(tracking: string, rows: readonly HualeiRow[], destination: string, tenant: HualeiTenant, label = ''): Facts['partner'] {
  const copied = tenant.copiedPartner;
  if (!copied || !tracking || !takes(copied.carrier, tracking, destination)) return undefined;
  if (label && namesAnotherCarrier(label, copied.carrier, tenant)) return undefined;
  return rows.some(copied.copies) ? { carrier: copied.carrier, number: tracking } : undefined;
}

/** The carriers a catalog name or a brand names, if any. */
const namedCarriers = (name: string): string[] => {
  const carrier = /[A-Za-z]/.test(name) ? carrierIdFromName(name) : undefined;
  return carrier ? [carrier] : brandCarrierIds(name);
};

/**
 * The carriers a channel label names: the one the platform's table gives it, or
 * the carriers of the label as a whole name, else of the longest runs of one to
 * three of its Latin words that name some, from the left ("GOFO" in
 * "GOFO美国专线", "DHL Paket" and not "Paket" in "DHL Paket Line").
 */
function labelCarriers(label: string): string[] {
  const key = normalizeStatusWording(label);
  if (Object.hasOwn(PARTNERS, key)) return [PARTNERS[key]!];
  const whole = namedCarriers(label);
  if (whole.length) return whole;
  const words = (label.match(/[A-Za-z0-9]+/g) ?? []).slice(0, 20);
  const carriers: string[] = [];
  for (let start = 0; start < words.length;) {
    const size = [3, 2, 1].find((length) => start + length <= words.length
      && namedCarriers(words.slice(start, start + length).join(' ')).length);
    if (size) carriers.push(...namedCarriers(words.slice(start, start + size).join(' ')));
    start += size ?? 1;
  }
  return [...new Set(carriers)];
}

/** Whether a channel label names a carrier other than the partner, a network of its brand and the tenant itself. */
function namesAnotherCarrier(label: string, partner: CarrierId, tenant: HualeiTenant): boolean {
  const brand = carrierBrand(partner);
  return labelCarriers(label).some((carrier) => carrier !== partner && carrier !== tenant.carrier
    && !(brand && carrierBrand(carrier) === brand));
}

/**
 * The delivery carrier and its number. Under a channel the platform's table
 * holds, the channel's transfer number, else the tracking number, which some
 * lines fill with the delivery carrier's. Otherwise the transfer number, the
 * tracking number a tenant's own number shape marks as the delivery carrier's,
 * or the invoice number, of a carrier the tenant hands to unnamed, or the
 * tracking number of the carrier whose scans the record copies, unless the
 * channel names another carrier; without a channel, also of the carrier the
 * record's product names.
 */
function partnerOf(record: JsonObject, destination: string, tenant: HualeiTenant, downstream = '', rows: readonly HualeiRow[] = []): Facts['partner'] {
  const { provider } = tenant;
  const label = text(record, 'channel_name', provider, 100);
  const number = (key: string) => identity(text(record, key, provider, 64));
  if (label) {
    for (const key of ['business_channeltransfercode', 'trackingNumber']) {
      const carrier = number(key) ? hualeiPartner(label, number(key), destination) : undefined;
      if (carrier) return { carrier, number: number(key) };
    }
  }
  // A number the partner's own rule claims whole is the partner's, unless the channel names another carrier.
  const unlabelled = unlabelledPartner([number('business_channeltransfercode'), downstream, number('business_seqinvoicecode')], tenant);
  if (unlabelled) return label && namesAnotherCarrier(label, unlabelled.carrier, tenant) ? undefined : unlabelled;
  const copied = copiedPartner(number('trackingNumber'), rows, destination, tenant, label);
  if (copied) return copied;
  if (label) return undefined;
  const product = downstream ? text(record, 'productKindName', provider, 100) : '';
  const named = product ? tenant.productPartners?.find(([pattern]) => pattern.test(product))?.[1] : undefined;
  return named && takes(named, downstream, destination) ? { carrier: named, number: downstream } : undefined;
}

/** An empty optional field: absent, null or an empty string. */
const blank = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * Some tenants' answer for a number they hold nothing under, in place of their no-row answer: one
 * record that only echoes the number as the shipper's reference, without an order id, any other of
 * its own numbers or a row, as the page's (`isUnknown`).
 */
function echoesOnly(records: readonly JsonObject[], number: string): boolean {
  const [record] = records;
  if (records.length !== 1 || !record) return false;
  const reference = record.referenceNumber;
  return typeof reference === 'string' && identity(reference) === identity(number) && blank(record.businessId)
    && IDENTITY_FIELDS.every((key) => key === 'referenceNumber' || blank(record[key]))
    && (blank(record.trackDetails) || (Array.isArray(record.trackDetails) && !record.trackDetails.length));
}

/**
 * The reply of `selectTrack.htm` for one number: the record whose own numbers
 * include the one asked, or null when the service says it holds no row for
 * it, or answers with a record that only echoes the number. Recipient, sender,
 * signature, fee and weight fields are never read. `page`, the tracking page for
 * the number, gives the rows whose wording or place GBK lost, when it shows the
 * number as one shipment.
 */
export function parseHualeiTrack(payload: unknown, raw: string, tenant: HualeiTenant, readAt = Date.now(), page?: string): CarrierResult | null {
  const { provider } = tenant;
  const number = normalizeHualeiNumber(raw, provider);
  if (!Array.isArray(payload) || payload.length !== 1 || !isRecord(payload[0])) {
    throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  }
  const reply = payload[0];
  if (reply.ack === 'false') {
    if (reply.message === NO_TRACK && reply.data === undefined) return null;
    throw new IndeterminateError(provider, `${provider} did not complete the lookup`);
  }
  if (reply.ack !== 'true') throw new SchemaError(provider, `${provider} returned an invalid envelope`);
  if (!Array.isArray(reply.data) || !reply.data.length || reply.data.length > MAX_RECORDS) {
    throw new SchemaError(provider, `${provider} returned an invalid record list`);
  }
  const records = reply.data.map((record) => {
    if (!isRecord(record)) throw new SchemaError(provider, `${provider} returned an invalid record`);
    return record;
  });
  // The page then settles it, as after the no-row answer.
  if (echoesOnly(records, number)) return null;
  // The service matches a number in any of the record's own fields; a reference two orders share is no answer.
  const bound = records.filter((record) => IDENTITY_FIELDS.some((key) => identity(text(record, key, provider, 64)) === identity(number)));
  const own = (value: string) => Boolean(tenant.ownNumber?.test(value));
  const trackingOf = (record: JsonObject) => identity(text(record, 'trackingNumber', provider, 64));
  const countryOf = (record: JsonObject) => text(record, 'consigneeCountry', provider, 8).toUpperCase();
  // The delivery carrier's number the interface found a lone record by, when it returns it in no field.
  let foundBy = '';
  if (!bound.length) {
    // The names of the fields that still carry the number, a list such as a child parcel's included, or eight
    // characters or more of it, never their values, tell a number the platform moved from another shipment or wrote
    // shorter. Failing both, the shapes of the record's own numbers tell a re-issued order from a hand-off.
    const fields = (holds: (value: string) => boolean, nested = false) => [...new Set(records.flatMap((record) => Object.entries(record)
      .filter(([, value]) => typeof value === 'string' ? holds(identity(value))
        : nested && typeof value === 'object' && value !== null && holds(identity(JSON.stringify(value))))
      .map(([key]) => key.slice(0, 40))))].slice(0, 4);
    const whole = fields((value) => value.includes(identity(number)), true);
    const part = whole.length ? [] : fields((value) => value.length >= 8 && identity(number).includes(value));
    // A tenant's own number the record holds nowhere is the one the interface found it by, once the delivery
    // carrier's number has taken its tracking number. On a tenant that finds orders by their delivery
    // carrier's number too, so is that carrier's, beside the tenant's own tracking number.
    const lone = records.length === 1 && !whole.length && !part.length ? records[0]! : undefined;
    if (lone && own(number) && !own(trackingOf(lone))) {
      bound.push(lone);
    } else if (lone && tenant.partnerNumbers && own(trackingOf(lone))
      && partnerOf(lone, countryOf(lone), tenant, identity(number))?.number === identity(number)) {
      bound.push(lone);
      foundBy = identity(number);
    } else {
      const shapes = whole.length || part.length ? [] : [...new Set(records.flatMap((record) => IDENTITY_FIELDS
        .map((key) => [key, text(record, key, provider, 64)] as const)
        .filter(([, value]) => value)
        .map(([key, value]) => `${key} ${numberShape(value)}`)))].slice(0, 4);
      throw new IndeterminateError(provider, `${provider} answered with another shipment${whole.length ? `; its ${whole.join(', ')} holds the number`
        : part.length ? `; its ${part.join(', ')} holds part of the number` : shapes.length ? `; its numbers read ${shapes.join(', ')}` : ''}`);
    }
  }
  if (new Set(bound.map(trackingOf)).size > 1) {
    throw new IndeterminateError(provider, `${provider} holds several shipments under the number`);
  }
  const record = bound[0]!;
  const details = record.trackDetails ?? [];
  if (!Array.isArray(details) || details.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an invalid history`);
  const destination = countryOf(record);
  const tracking = trackingOf(record);
  // On a tenant that names its own numbers, a tracking number of another shape is the delivery carrier's.
  const downstream = tenant.ownNumber && tracking && !own(tracking) ? tracking : '';
  const given = details.map((row) => trackRow(row, provider));
  const rows = page !== undefined && given.some((row) => hualeiLostToGbk(row.content) || hualeiLostToGbk(row.location))
    ? restoreLostRows(given, shownRows(page, number, tenant)) : given;
  // Else the number the newest row that hands the parcel on names, the rows coming newest first.
  const handed = downstream || text(record, 'business_channeltransfercode', provider, 64) || !tenant.handOff ? ''
    : rows.map((row) => identity(tenant.handOff!(row.content) ?? '')).find((value) => value && value !== identity(number)) ?? '';
  const onward = downstream || handed || foundBy;
  return result(rows, {
    number, destination, partner: partnerOf(record, destination, tenant, onward, rows),
    tracking: downstream ? '' : tracking, ...(onward ? { downstream: onward } : {}),
    service: hualeiServiceName(text(record, 'productKindName', provider, 100)) || undefined,
  }, tenant, readAt);
}

interface PageWaybill {
  readonly pieces: string | null;
  readonly cells: ReadonlyMap<string, string>;
  readonly rows: readonly HualeiRow[];
}

function pageWaybill($: CheerioAPI, block: Parameters<CheerioAPI>[0], provider: string): PageWaybill {
  const heading = clean($(block).find('.danhao').first().text(), 1000);
  const pieces = /件数\s*[:：]\s*【([^】]*)】/.exec(heading)?.[1]?.trim() ?? null;
  const lists = $(block).find('.menu_ ul');
  const headers = lists.eq(0).children('li').toArray().map((item) => clean($(item).text(), 100));
  const values = lists.eq(1).children('li').toArray();
  if (lists.length !== 2 || !headers.length || headers.length !== values.length) {
    throw new SchemaError(provider, `${provider} returned an invalid waybill`);
  }
  const cells = new Map<string, string>();
  headers.forEach((header, index) => {
    if (header !== RECIPIENT_COLUMN) cells.set(header, clean($(values[index]).text(), 500));
  });
  const rows = $(block).find('.difmeam table tr').toArray().map((tr) => {
    const row = $(tr).children('td').toArray().map((td) => clean($(td).text(), 500));
    if (row.length !== 3) throw new SchemaError(provider, `${provider} returned an invalid scan`);
    return { clock: row[0]!, location: row[1]!, content: row[2]!, code: '' };
  });
  return { pieces, cells, rows };
}

/**
 * The page's answer for a number it holds nothing for: one waybill that only
 * echoes the number as a reference, without pieces, destination, clock,
 * tracking number or history.
 */
function isUnknown(waybill: PageWaybill, number: string): boolean {
  const { cells } = waybill;
  return waybill.pieces === '' && !waybill.rows.length && !cells.has('跟踪号码')
    && identity(cells.get('参考号') ?? '') === identity(number)
    && !cells.get('目的地') && !cells.get('当地时间') && !cells.get('渠道转单号');
}

/** The page's waybill bound to the number. */
function boundWaybill(html: string, number: string, tenant: HualeiTenant): PageWaybill {
  const { provider } = tenant;
  const $ = load(html);
  const blocks = $('div.div_canta div.div_cont').toArray();
  const bareForm = $('textarea[name="documentCode"]').length === 1 && $('input#codes').length === 1 && !($('input#codes').attr('value') ?? '').trim();
  if (!blocks.length && tenant.bareUnknownPage && bareForm) throw new NotFoundError(provider);
  if (!blocks.length || blocks.length > MAX_RECORDS) throw new SchemaError(provider, `${provider} returned a page without its results`);
  const waybills = blocks.map((block) => pageWaybill($, block, provider));
  if (waybills.length === 1 && isUnknown(waybills[0]!, number)) throw new NotFoundError(provider);
  const shown = (waybill: PageWaybill) => Boolean(waybill.pieces || waybill.rows.length || waybill.cells.get('目的地'));
  const holds = (waybill: PageWaybill, columns: readonly string[]) =>
    columns.some((column) => identity(waybill.cells.get(column) ?? '') === identity(number));
  // The unknown-number answer echoes the number as a reference only. An order the tracker holds
  // shows it as its tracking or transfer number even before it has pieces, a destination or a scan.
  const bound = waybills.filter((waybill) => (shown(waybill) && holds(waybill, PAGE_IDENTITY_COLUMNS)) || holds(waybill, PAGE_OWN_COLUMNS));
  // The page shows one block per number its form echoes back, one per line: on
  // a tenant that hides the number it found an order by, a lone record answers
  // the only number echoed. So does it for a tenant's own number, as on the interface, once the
  // delivery carrier's number has taken the tracking number, unless that is another of its own.
  const echo = ($('input#codes').attr('value') ?? '').split(/[\r\n]+/).map(identity).filter(Boolean);
  const own = (value: string) => Boolean(tenant.ownNumber?.test(value));
  const hides = (waybill: PageWaybill) => tenant.pageEcho || (own(number) && !own(identity(waybill.cells.get('跟踪号码') ?? '')));
  const echoed = !bound.length && waybills.length === 1 && shown(waybills[0]!) && hides(waybills[0]!)
    && echo.length === 1 && echo[0] === identity(number);
  if (echoed) bound.push(waybills[0]!);
  if (bound.length !== 1) throw new IndeterminateError(provider, `${provider} did not show the number as one shipment`);
  const waybill = bound[0]!;
  if (waybill.rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an invalid history`);
  return waybill;
}

/** The page's rows for the number, or none when it does not show the number as one shipment. */
function shownRows(html: string, number: string, tenant: HualeiTenant): readonly HualeiRow[] {
  try {
    return boundWaybill(html, number, tenant).rows;
  } catch {
    return [];
  }
}

/**
 * The tracking page `trackIndex.htm` for one number. It finds an order by its
 * tracking number or the shipper's reference, and shows the platform's own row
 * for an order without scans, which the track interface leaves out.
 */
export function parseHualeiPage(html: string, raw: string, tenant: HualeiTenant, readAt = Date.now()): CarrierResult {
  const number = normalizeHualeiNumber(raw, tenant.provider);
  const waybill = boundWaybill(html, number, tenant);
  const tracking = identity(waybill.cells.get('跟踪号码') ?? '');
  const transfer = identity(waybill.cells.get('渠道转单号') ?? '');
  // The numbers a page-echo tenant's page shows are the delivery carrier's, never its own; on a
  // tenant that names its own numbers, as on the interface, so is a tracking number of another shape.
  const handed = Boolean(tenant.ownNumber && tracking && !tenant.ownNumber.test(tracking));
  const downstream = tenant.pageEcho ? transfer || tracking : handed ? tracking : '';
  // The page names no channel, product or invoice number, so only a partner the tenant hands to unnamed, or whose
  // scans it copies, is read.
  const destination = (waybill.cells.get('目的地') ?? '').toUpperCase();
  return result(waybill.rows, {
    number, tracking: tenant.pageEcho || handed ? '' : tracking, ...(downstream ? { downstream } : {}), destination,
    partner: unlabelledPartner([transfer, downstream], tenant) ?? copiedPartner(tracking, waybill.rows, destination, tenant),
  }, tenant, readAt, true);
}

/** The track interface's body: GBK unless the reply says UTF-8. */
function trackText(response: Response, bytes: Uint8Array): string {
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]?.toLowerCase();
  return decodeText(bytes, charset === 'utf-8' || charset === 'utf8' ? 'utf-8' : 'gbk').replace(/^\uFEFF/, '');
}

/** Whether the failure is the tenant's answer for an order it holds with no scan due yet. */
function heldWithoutScans(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1, current = current.cause) {
    if (current instanceof NoHistoryError) return true;
  }
  return false;
}

/** One lookup on a tenant's tracker, sent once more after a network failure. */
export class HualeiTracker {
  constructor(private readonly tenant: HualeiTenant,
    private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string } = {}) {}

  /** The HTTP statuses that are not the service's answer. */
  private refuse(response: Response): void {
    const { provider } = this.tenant;
    if (response.status === 429) throw new RateLimitedError(provider, retryAfterMs(response.headers.get('retry-after'), { dates: false, maxDigits: 6 }));
    if (REDIRECTS.includes(response.status)) throw new TransportError(provider, `${provider} redirected its tracking lookup`);
    if (GONE.includes(response.status)) throw new TransportError(provider, `${provider} tracking lookup is unavailable`);
  }

  private async track(number: string, signal: AbortSignal, left: () => number): Promise<CarrierResult | null> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(hualeiTrackUrl(this.tenant, number), { method: 'GET', signal, headers: {
      Accept: 'application/json, text/plain, */*', 'User-Agent': userAgentOf(this.options.userAgent),
    } }, { provider, timeoutMs: left(), maxBytes: TRACK_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    this.refuse(response);
    const body = trackText(response, bytes);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch (cause) {
      if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a block page`, { cause });
      throw new SchemaError(provider, `${provider} returned a reply that is not JSON`, { cause });
    }
    // A row whose wording or place GBK lost is read from the page, which is UTF-8. A page that cannot
    // be read leaves the reply as it came; a lookup whose signal has ended stops.
    const page = losesText(payload) ? await this.pageHtml(number, signal, left()).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    }) : undefined;
    return parseHualeiTrack(payload, number, this.tenant, Date.now(), page);
  }

  private async pageHtml(number: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    const { provider } = this.tenant;
    const { response, bytes } = await fetchBounded(new URL(HUALEI_PAGE_PATH, this.tenant.origin), { method: 'POST', signal, headers: {
      Accept: 'text/html,application/xhtml+xml', 'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgentOf(this.options.userAgent),
    }, body: new URLSearchParams({ documentCode: number }) }, { provider, timeoutMs, maxBytes: PAGE_MAX_BYTES,
      redirect: 'manual', fetcher: this.options.fetcher, allowHttpStatuses: [...REDIRECTS, ...GONE, 429] });
    this.refuse(response);
    const html = decodeText(bytes);
    if (!html.includes('div_canta')) {
      if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(provider, `${provider} answered with a block page`);
      throw new SchemaError(provider, `${provider} returned a page without its results`);
    }
    return html;
  }

  private async page(number: string, signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> {
    return parseHualeiPage(await this.pageHtml(number, signal, timeoutMs), number, this.tenant, Date.now());
  }

  /**
   * Whether the tenant holds the number. An order without a scan due yet is held: the page
   * echoes an unknown number bare, which is not-found, and shows an order it holds.
   */
  async recognize(raw: string, context: TrackingContext = {}): Promise<Recognition> {
    try {
      return await recognizeFromLookup(() => this.fetch(raw, context), () => accepted(() => normalizeHualeiNumber(raw, this.tenant.provider)));
    } catch (error) {
      if (heldWithoutScans(error)) return { known: true, lastActivityAt: null };
      throw error;
    }
  }

  async fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    const number = normalizeHualeiNumber(raw, this.tenant.provider);
    // The track interface first; its "no row" answer is settled by the page,
    // which tells an unknown number from an order without scans.
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      return await this.track(number, signal, left) ?? await this.page(number, signal, left());
    };
    // A request that fails to reach the tracker, or hangs, gets one more try:
    // the first gets half of the budget, so the retry fits in the rest.
    return runSteps({ carrier: this.tenant.carrier, budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}
