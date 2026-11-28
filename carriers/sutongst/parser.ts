import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { canadaProvinceTimeZone, countryCode, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, sutongstStage } from './status.js';

export const PROVIDER = 'Sutong International Express';
export const CARRIER = 'sutongst';
// A waybill's rows come to a few kilobytes.
export const SUTONGST_MAX_BYTES = 512 * 1024;
/** The clock of the firm's stations in Shenzhen. */
const CHINA = 'Asia/Shanghai';
// ST and twelve digits on the public samples; the page takes any waybill.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "2026-11-19 16:59:24": the wall clock the system writes, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
// "【深圳】…" or "[California]…": the place a row starts with.
const PREFIX = /^\s*(?:【([^【】]{1,60})】|\[([^[\]]{1,60})\])\s*/u;
// "中国-US": a leg between two places, which names no one clock.
const ROUTE = /[-－—–]/u;
const HAN = /\p{Script=Han}/u;
// US states by name, for the North American rows that name one.
const US_STATES: Readonly<Record<string, string>> = Object.fromEntries((
  'ALABAMA:AL ALASKA:AK ARIZONA:AZ ARKANSAS:AR CALIFORNIA:CA COLORADO:CO CONNECTICUT:CT DELAWARE:DE FLORIDA:FL '
  + 'GEORGIA:GA HAWAII:HI IDAHO:ID ILLINOIS:IL INDIANA:IN IOWA:IA KANSAS:KS KENTUCKY:KY LOUISIANA:LA MAINE:ME '
  + 'MARYLAND:MD MASSACHUSETTS:MA MICHIGAN:MI MINNESOTA:MN MISSISSIPPI:MS MISSOURI:MO MONTANA:MT NEBRASKA:NE '
  + 'NEVADA:NV NEW_HAMPSHIRE:NH NEW_JERSEY:NJ NEW_MEXICO:NM NEW_YORK:NY NORTH_CAROLINA:NC NORTH_DAKOTA:ND OHIO:OH '
  + 'OKLAHOMA:OK OREGON:OR PENNSYLVANIA:PA RHODE_ISLAND:RI SOUTH_CAROLINA:SC SOUTH_DAKOTA:SD TENNESSEE:TN TEXAS:TX '
  + 'UTAH:UT VERMONT:VT VIRGINIA:VA WASHINGTON:WA WEST_VIRGINIA:WV WISCONSIN:WI WYOMING:WY'
).split(' ').map((pair) => [pair.slice(0, -3).replace(/_/gu, ' '), pair.slice(-2)]));
// Canadian provinces by name. Ontario is left out: it is also the Californian city with the carriers' hubs, and
// the rows before it here are Californian.
const CANADA_PROVINCES: Readonly<Record<string, string>> = {
  'BRITISH COLUMBIA': 'BC', ALBERTA: 'AB', SASKATCHEWAN: 'SK', MANITOBA: 'MB', QUEBEC: 'QC', 'NEW BRUNSWICK': 'NB',
  'NOVA SCOTIA': 'NS', 'PRINCE EDWARD ISLAND': 'PE', 'NEWFOUNDLAND AND LABRADOR': 'NL',
};
// Couriers in North America the reply may name as the local carrier.
const LOCAL_CARRIERS: readonly (readonly [RegExp, string])[] = [
  [/^USPS$|United States Postal/iu, 'usps'], [/^UPS\b/iu, 'ups'], [/^FedEx/iu, 'fedex'], [/Canada\s*Post|Postes\s*Canada/iu, 'canada-post'],
  [/^OnTrac/iu, 'ontrac'], [/^UniUni/iu, 'uniuni'], [/^GOFO/iu, 'gofo'],
];
// A clause that names who took the parcel in, or gives a phone.
const SIGNER = /^\s*(?:(?:Delivered|Signed(?:\s+by)?|Received\s+by|Recipient)\s*[:：]?\s+\S|(?:签收人|收件人|代收人)\s*[:：]?\s*\S)/iu;
const SIGNER_WORD = /^\s*(?:Delivered|Signed|Received)/iu;
const CONTACT = /电话|手机|联系|快递员|派送员|派件员|Tel\b|Phone|(?<![A-Z\d])\+?\d[\d\s-]{7,}\d/iu;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** A waybill on Sutong's tracker, without spaces or hyphens. */
export function normalizeSutongstNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Sutong waybills are 6 to 30 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

/**
 * A row's text without who took the parcel in or a phone: each clause that names a signer or gives a phone
 * goes. "[Ontario]Have been delivered" from the delivery row that goes on to name the signer.
 */
export function sutongstText(value: string): string {
  const text = value.replace(/<[^>]*>/gu, ' ');
  const prefix = PREFIX.exec(text)?.[0] ?? '';
  // Each clause keeps the comma after it, so the kept ones read as written.
  const clauses = text.slice(prefix.length).split(/(?<=[,，;；])/u).filter((clause) => clause.replace(/[,，;；]$/u, '').trim());
  const kept = clauses.filter((clause) => !SIGNER.test(clause) && !CONTACT.test(clause));
  // A row that is nothing but its signer keeps the word that says so.
  const said = kept.length ? kept.join('') : SIGNER_WORD.exec(clauses[0] ?? '')?.[0] ?? '';
  return said ? clean(`${prefix}${said}`, 300).replace(/[\s,，;；:：。]+$/gu, '') : '';
}

interface Clock {
  readonly zone: string;
  readonly country: string | null;
}

/**
 * The clock a row's place names: a place in China written in Chinese is on China's, a US state or a Canadian
 * province on its zone. A leg between two places, or a place that names no one zone, names none.
 */
export function placeClock(place: string): Clock | null {
  if (ROUTE.test(place)) return null;
  if (HAN.test(place)) return /香港/u.test(place) ? { zone: 'Asia/Hong_Kong', country: 'HK' } : { zone: CHINA, country: 'CN' };
  const name = place.trim().toUpperCase().replace(/\s+/gu, ' ');
  const state = Object.hasOwn(US_STATES, name) ? usStateTimeZone(US_STATES[name]) : null;
  if (state) return { zone: state, country: 'US' };
  const province = Object.hasOwn(CANADA_PROVINCES, name) ? canadaProvinceTimeZone(CANADA_PROVINCES[name]) : null;
  return province ? { zone: province, country: 'CA' } : null;
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}` : '';
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/** The local carrier and its number the reply names, when the catalog has that carrier and its rules offer the number. */
function handoffOf(payload: Record<string, unknown>, number: string): Handoff | null {
  const name = typeof payload.localCarrier === 'string' ? payload.localCarrier.trim() : '';
  const onward = typeof payload.localNumber === 'string' && payload.localNumber.length <= 64 ? normalizeTrackingNumber(payload.localNumber) : '';
  if (!name || onward.length < 8 || onward === number) return null;
  const named = LOCAL_CARRIERS.filter(([pattern]) => pattern.test(name)).map(([, carrier]) => carrier);
  if (named.length !== 1 || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

/**
 * The rows of the reply. `LatestState` NotFound with no rows is the tracker's answer for a waybill it does not
 * know; anything else without rows is inconclusive. The reply does not repeat the number.
 */
function rowsOf(payload: unknown): { readonly reply: Record<string, unknown>; readonly rows: unknown[] } {
  if (!isRecord(payload) || !('LatestState' in payload) || !Array.isArray(payload.data) || payload.data.length > MAX_ROWS) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  }
  if (!payload.data.length) {
    if (payload.LatestState === 'NotFound' && String(payload.status) === '0') throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (String(payload.status) !== '1') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  return { reply: payload, rows: payload.data as unknown[] };
}

/**
 * Sutong's history for one waybill, newest first as the reply lists it: the reply of `API/Express/`,
 * `{status, state, LatestState, fromCountry, toCountry, localCarrier, localNumber, data}`, each row a `time`
 * wall clock without a zone and a `context` that starts with its place in brackets. A place in China is on
 * China's clock, a US state or a Canadian province on its zone; a leg between two places, or a place that names
 * no one zone, keeps its wall clock alone. A zone that would date a row after the lookup leaves it its wall
 * clock. `LatestState` stays InTransit after the delivery, so the stage is read from the rows. Who took the
 * parcel in is taken out.
 */
export function parseSutongst(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeSutongstNumber(raw);
  const { reply, rows } = rowsOf(payload);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  let destination = countryCode(reply.toCountry);
  for (const entry of rows) {
    if (!isRecord(entry) || typeof entry.context !== 'string' || entry.context.length > 4000) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    }
    const local = wallClock(entry.time);
    const description = sutongstText(entry.context);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const prefix = PREFIX.exec(description);
    const place = clean(prefix?.[1] ?? prefix?.[2] ?? '', 60);
    const clock = place ? placeClock(place) : null;
    if (clock && clock.country !== 'CN' && clock.country !== 'HK') destination ??= clock.country;
    const instant = clock ? firstOccurrence(DateTime.fromISO(local, { zone: clock.zone })) : null;
    const dated = instant && instant.toMillis() <= readAt + CLOCK_SKEW_MS;
    const staged = sutongstStage(description);
    events.push({
      ...(dated ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: clock!.zone, time_zone_basis: 'place' } : {}),
      local_time: local, ...(place && !ROUTE.test(place) ? { location: place } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const handoff = handoffOf(reply, number);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(destination && destination !== 'CN' ? { destination_country: destination } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
