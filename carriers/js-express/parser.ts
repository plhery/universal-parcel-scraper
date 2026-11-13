import { DateTime } from 'luxon';
import { CARRIER_DEFINITIONS } from '../../core/catalog/definitions.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, canadaProvinceTimeZone, countryCode, firstOccurrence, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { hasSeveralClocks, mainZone } from '../../places/zones.js';
import { jsExpressChinaClock } from './clock.js';
import { IMILE_RECEIVER, LIST_PLACE } from './identity.js';
import { isJsExpressDepotReceipt, jsExpressEnglish, jsExpressStage } from './status.js';

export const PROVIDER = 'JS Express';
// A reply is a few kilobytes; five hundred rows stay under 256 kB.
export const JS_EXPRESS_MAX_BYTES = 256 * 1024;

// JSE, two letters, ten digits and YQ.
const NUMBER = /^JSE[A-Z]{2}\d{10}YQ$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The lookup's answer for a number it does not know.
const NOT_FOUND = '未获取到任何数据';
// The answer the lookup prints, before its own, to a request that does not come from the tracking page.
const REFUSED = '非法请求';
const REFUSAL = /^\s*\{\s*"code"\s*:\s*1\s*,\s*"message"\s*:\s*"非法请求"\s*\}(?=\s*\{)/;
// The image captcha the Chinese page's lookup asks for, should this one ask it too.
const CAPTCHA = /验证码/;
// DHL Paket's rows in its English, as a German parcel's history relays them: its advice of the
// parcel's data, its record of the parcel on its way to it, its first scan in Germany and its
// transport to the delivery base.
const DHL_PAKET_ROW = /^The (?:instruction data for this shipment have been provided by the sender to DHL electronically|shipment is in transit to DHL|shipment has been processed in the parcel center of origin|shipment arrived in the region of recipient and will be transported to the delivery base in the next step)\.?$/;
// A firewall or bot check's page, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|geetest/i;
// A run of nine or more digits, with the separators phone numbers are written with; a date stays.
const PHONE = /(?<![A-Z\d])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d(?:[\s().-]{0,2}\d){8,}(?![A-Z\d])/gi;
// The label a phone number followed, left at the end without it: "，当地电话：" (local phone), or "Local phone number:/".
const PHONE_LABEL = /[\s,，;；]*(?:(?:当地|联系)?电话|(?:local\s+)?(?:tel(?:ephone)?|phone(?:\s+number)?))\s*[:：]\s*\/?\s*$/i;
// Who took a delivered parcel, as a courier's delivery line can name them.
const RECEIVER = /\s*[,;:.\-–]?\s*\b(?:(?:signed|received|collected|accepted)(?:\s+for)?\s+by|signed|signatory|signature)\b.*$/i;
// The place a destination courier's wording ends with, as "Delivered (Sample Town, ON)".
const PLACE = /\s*\(([^()]{1,120})\)$/;
// Straightship, the Canadian courier, names itself in its station rows and its delivery attempts.
const STRAIGHTSHIP = /straightship/i;
// Straightship's record of the parcel's data, its first row on its own page, in the same words and without a place.
const STRAIGHTSHIP_RECORD = /^package information is created in the system$/i;
// A town and the code of its province or state, as a courier's wording ends with them.
const PROVINCE = /,\s*([A-Z]{2})$/;
// USPS's scans, relayed from two feeds: to the minute with the town, state and postal code, on the town's clock, or to
// the second on UTC's.
const USPS = /\busps\b/i;
// The offset a row states, as "+02:00".
const OFFSET = /^[+-]\d{2}:\d{2}$/;
// J&T Express Germany's rows in German, as the destination courier: its scans opening with the district in 【】, its
// round, its delivery and its record of the order's data.
const J_AND_T_GERMANY = /^【[^】]*】.*\b(?:Sendung|Paket)\b|^Die Sendung von 【[^】]*】 in 【[^】]*】 ist unterwegs zur Zustellung\b|^Ihr Paket wurde erfolgreich zugestellt\b|^Die Auftragsdaten für diese Sendung wurden elektronisch an J&T Express übermittelt\b/u;
// A row's code, as "OIT" or "DSD".
const CODE = /^[A-Z]{2,4}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** A JS Express waybill number; anything else is not one it issues. */
export function normalizeJsExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'JS Express waybills are JSE, two letters, ten digits and YQ');
  return number;
}

/**
 * A row's wording and place. The place is the page's 【…】 label, which a
 * destination courier's wording repeats with its province, "(Sample Town,
 * ON)": the wording then loses it and the place takes it. A label without a
 * letter, such as "1", or the tracker's "Array", names no place. A delivery
 * loses a clause naming who took it, as iMile's receiver type does, and every
 * row loses phone numbers and the label left before them.
 */
export function jsExpressScan(status: string, address: string): { description: string; location: string } {
  let description = clean(clean(status, 300).replace(IMILE_RECEIVER, ''));
  let location = clean(address, 120);
  const place = PLACE.exec(description);
  if (place && location && clean(place[1]).toLowerCase().startsWith(location.toLowerCase())) {
    description = description.slice(0, place.index);
    location = clean(place[1], 120);
  }
  if (/^delivered\b/i.test(description)) description = description.replace(RECEIVER, '');
  const site = clean(location.replace(PHONE, ''));
  return { description: clean(description.replace(PHONE, '')).replace(PHONE_LABEL, '').replace(/[\s,，;；:：-]+$/, ''),
    location: /\p{L}/u.test(site) && site !== LIST_PLACE ? site : '' };
}

/** A row's clock: the scanning site's wall clock to the second, with no zone. */
function wallClock(stamp: string): string {
  const match = CLOCK.exec(stamp);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  // Luxon rolls 24:00:00 over to the next day; only a clock that reads back unchanged is kept.
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'JS Express returned an invalid scan time');
  }
  return local;
}

/** Whether the courier's wording gave the row its place, a town and a Canadian province. */
function canadianTown(location: string, label: string): boolean {
  return location.toLowerCase() !== label.toLowerCase() && Boolean(canadaProvinceTimeZone(PROVINCE.exec(location)?.[1]));
}

/**
 * The zone a row's wall clock keeps, where the row settles it. A row at a
 * place in mainland China is on Beijing time, JS Express's and its line's
 * warehouse, sorting and export rows alike; a flight's departure filed there
 * keeps its wall clock. In a history that names Straightship, its rows are on
 * UTC, as its own page writes them: those that name it, those whose wording
 * ended with a town and a Canadian province, and its record of the parcel's
 * data. USPS's scans relayed to the second are on UTC too. Null otherwise:
 * airports' codes, other rows without a place and other couriers' rows.
 */
function scanZone(local: string, description: string, location: string, label: string, straightship: boolean): string | null {
  if (straightship && (STRAIGHTSHIP.test(description) || canadianTown(location, label)
    || (!location && STRAIGHTSHIP_RECORD.test(description)))) return 'UTC';
  if (USPS.test(description) && !local.endsWith(':00')) return 'UTC';
  return jsExpressChinaClock(description, location) ?? null;
}

/**
 * The destination's clock for a row without a place, when the destination
 * keeps one clock and the offset the row states is that clock's at the row's
 * wall clock: the destination courier's and post's rows, relayed from another
 * country's post or not. Other rows' offsets are not read: Straightship's
 * carry China's, and the airports' can be another country's.
 */
function statedZone(local: string, offset: string, country: string | null): string | null {
  const zone = country && OFFSET.test(offset) && !hasSeveralClocks(country) ? mainZone(country) : null;
  return zone && firstOccurrence(DateTime.fromISO(local, { zone })).toFormat('ZZ') === offset ? zone : null;
}

/**
 * The instant of J&T Express Germany's rows, their wall clock at the offset they state. Neither is Germany's
 * clock, but together they give the instant J&T Express Germany's own tracker gives the same scan, to the
 * second; read on Berlin's clock, its scans would come two hours early.
 */
function statedInstant(local: string, offset: string, description: string): string | undefined {
  if (!OFFSET.test(offset) || !J_AND_T_GERMANY.test(description)) return undefined;
  const instant = DateTime.fromISO(`${local}${offset}`, { setZone: true });
  return instant.isValid ? instant.toISO({ suppressMilliseconds: true }) ?? undefined : undefined;
}

/** An optional string a row can carry; anything else counts as none. */
const optional = (record: Record<string, unknown>, key: string): string => (typeof record[key] === 'string' ? clean(record[key], 16) : '');

/** An optional text field; anything but a string is a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `JS Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * The lookup's body as JSON. Without the tracking page as its referrer, the
 * lookup prints a refusal before its answer, which is dropped; a block page
 * in place of JSON is a challenge.
 */
export function jsExpressReply(body: string): unknown {
  if (!body.trim()) throw new IndeterminateError(PROVIDER, 'JS Express returned an empty reply');
  try {
    return JSON.parse(body.replace(REFUSAL, ''));
  } catch (cause) {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'JS Express answered with a block page', { cause });
    throw new SchemaError(PROVIDER, 'JS Express returned a reply that is not JSON', { cause });
  }
}

/**
 * The destination courier's number, `trackNo`, and that courier when it works
 * in the country the parcel goes to and the catalog settles the number for it
 * at high confidence, or the number has a shape DHL Paket shares, its twelve
 * digits or JJD and sixteen, and the history holds DHL Paket's own rows. The
 * reply names no courier. A USPS routing barcode gives its package identifier.
 */
function handoff(waybill: Record<string, unknown>, number: string, country: string | null, descriptions: readonly string[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const compact = normalizeTrackingNumber(text(waybill, 'trackNo', 64)).toUpperCase();
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const detected = detectCarrierMatch(reference);
  const named = detected.confidence === 'high' ? detected.carrier
    : detected.candidates.includes('dhl') && descriptions.some((description) => DHL_PAKET_ROW.test(description)) ? 'dhl' : undefined;
  const partner = named && named !== 'js-express' && country && CARRIER_DEFINITIONS[named]?.countries?.includes(country) ? named : undefined;
  return { ...(partner ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

// The estimate the page shows, a day with or without a clock after it.
const ESTIMATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
// Straightship's round, "Package will be delivered before 9:00pm": a delivery or an attempt follows the same day.
const ROUND = /^Package will be delivered before \d{1,2}:\d{2} ?[ap]m$/i;

/** The day of the waybill's `estimateArriveTime`, whose clock, if any, names no zone. */
function estimateDay(waybill: Record<string, unknown>): string | null {
  const match = typeof waybill.estimateArriveTime === 'string' ? ESTIMATE.exec(clean(waybill.estimateArriveTime, 32)) : null;
  return match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/** The day of Straightship's round, on the clock of the province its town is in. */
function roundDay(event: CarrierEvent): string | null {
  const zone = canadaProvinceTimeZone(PROVINCE.exec(String(event.location ?? ''))?.[1]);
  if (!zone || typeof event.time !== 'string' || !ROUND.test(event.description ?? '')) return null;
  const day = DateTime.fromISO(event.time, { setZone: true }).setZone(zone);
  return day.isValid ? day.toISODate() : null;
}

/**
 * The reply of the English tracking page's lookup `index.php?c=trace` for one
 * number: `code` 0 and the waybill, with the country it goes to, the
 * destination courier's number once it has one, and the scans newest first by
 * wall clock, each a date, a place, a wording, a code and an offset. An
 * unknown number gets `code` 1 and "未获取到任何数据,请提供有效单号!". The
 * shop's order number and the delivery photos are not read.
 */
export function parseJsExpress(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeJsExpressNumber(rawNumber);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'JS Express returned an invalid reply');
  if (payload.code !== 0) {
    const message = text(payload, 'message', 200);
    if (payload.code === 1 && message.startsWith(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    if (message === REFUSED) throw new ChallengeError(PROVIDER, 'JS Express refused the lookup');
    if (CAPTCHA.test(message)) throw new ChallengeError(PROVIDER, 'JS Express asked for its captcha');
    throw new SchemaError(PROVIDER, 'JS Express returned an unexpected answer');
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'JS Express returned an invalid reply');
  const waybills = payload.data.map((waybill: unknown) => {
    if (!isRecord(waybill) || typeof waybill.jsWaybillNo !== 'string') throw new SchemaError(PROVIDER, 'JS Express returned a waybill without its number');
    return waybill;
  }).filter((waybill) => normalizeTrackingNumber(clean(waybill.jsWaybillNo, 64)) === number);
  if (waybills.length !== 1) throw new SchemaError(PROVIDER, 'JS Express answered for another waybill');
  const waybill = waybills[0]!;
  const rows = waybill.tracking;
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'JS Express returned a waybill with invalid scans');
  // The page's script says "暂无轨迹数据" for a waybill without scans.
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'JS Express returned an oversized history');

  const destination = text(waybill, 'country', 60);
  const country = countryCode(destination);
  const seen = new Set<string>();
  const scans: { local: string; label: string; description: string; location: string; offset: string; code: string | null }[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.date !== 'string' || typeof row.status !== 'string') throw new SchemaError(PROVIDER, 'JS Express history changed');
    const label = text(row, 'address', 200);
    const local = wallClock(clean(row.date, 32));
    const { description, location } = jsExpressScan(row.status, label);
    if (!description) throw new SchemaError(PROVIDER, 'JS Express returned a scan without wording');
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const code = optional(row, 'code');
    scans.push({ local, label: clean(label, 120), description, location, offset: optional(row, 'timeZone'), code: CODE.test(code) ? code : null });
  }

  const straightship = scans.some((scan) => STRAIGHTSHIP.test(scan.description));
  const events = scans.map(({ local, label, description, location, offset, code }): CarrierEvent => {
    const stated = statedInstant(local, offset, description);
    const zone = stated ? null : scanZone(local, description, location, label, straightship) ?? (location ? null : statedZone(local, offset, country));
    const time = stated ?? (zone ? isoTime(local, zone)?.iso : undefined);
    const staged = jsExpressStage(description, code);
    return {
      ...(time ? { time } : { local_time: local }),
      ...(location ? { location } : {}),
      description: jsExpressEnglish(description) ?? description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });

  // Oldest first: the depot's receipt keeps the stage of the scan before it with no source of its own. Before a round
  // the parcel is in transit; after a missed delivery it is back from that round, waiting for the next one or for the
  // recipient's request.
  let previous: Stage | undefined;
  for (const event of [...events].reverse()) {
    if (previous && isJsExpressDepotReceipt(event.description ?? '')) Object.assign(event, { stage: previous, stage_source: 'none' });
    // A note mapped as pending, such as the call to the recipient, keeps the stage before it too.
    if (event.stage !== 'pending') previous = (event.stage as Stage | undefined) ?? previous;
  }

  // The reply's order stands: a history mixes the clocks of several countries.
  // The newest row's instant, when it has one, is the last update, and a dated
  // delivery's is the delivery time.
  const newest = events[0]!;
  const moved = (event: CarrierEvent) => event.stage && event.stage_source !== 'none';
  const current = events.find((event) => moved(event) && event.stage !== 'pending') ?? events.find(moved);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.time ? {} : { last_update_local: newest.local_time! }),
    ...(stage === 'delivered' && current!.time ? { delivered_at: current!.time } : {}),
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null
      : (stage === 'out_for_delivery' ? roundDay(current!) : null) ?? estimateDay(waybill),
    ...(country ? { destination_country: country } : destination ? { destination_country_name: destination } : {}),
    ...handoff(waybill, number, country, scans.map((scan) => scan.description)),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
