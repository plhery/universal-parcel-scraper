import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isValidUpsTrackingNumber } from '../../core/detection/ups.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, countryTimeZone, firstOccurrence, usStateTimeZone } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { statusMap, xiongdaStage } from './status.js';

export const PROVIDER = 'Xiong Da International Logistics';
export const CARRIER = 'xiongda';
// The reply is about 18 kilobytes with some thirty rows.
export const XIONGDA_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit, as the tracking page's box takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const MAX_ROWS = 300;
// What the firm's system writes for a city it does not know: 市辖区, "the city's districts", or its pinyin.
const NO_CITY = /^(?:市辖区|shixiaqu)$/iu;
// A town and a US state's code, as "LOS ANGELES, CA" or "Ontario, CA, US".
const US_PLACE = /^[A-Za-z][A-Za-z .'-]{1,40},\s*([A-Z]{2})(?:\s*,\s*(?:US|USA))?$/;
// States whose towns keep more than one clock: the state alone does not settle a row's.
const SPLIT_STATES = new Set(['AK', 'AZ', 'FL', 'ID', 'IN', 'KS', 'KY', 'MI', 'ND', 'NE', 'NV', 'OR', 'SD', 'TN', 'TX']);
// Where a note turns to a person: who signed or received the parcel, or a phone.
const PERSONAL = /[\s,，;；:：]*(?:\b(?:signed (?:for )?by|received by|signer|signature)\b|签收人|签收者|收件人|签字|(?<![\d-])(?:1[3-9]\d{9}|\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4})(?![\d-]))/iu;
const UPS = /\bUPS\b/;
const UPS_NUMBER = /\b1Z[0-9A-Z]{16}\b/g;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const numberOf = (value: unknown): string => normalizeTrackingNumber(cleanScalar(value, 64));

/** A waybill on the firm's tracker, without spaces or hyphens. */
export function normalizeXiongdaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Xiong Da waybills are 8 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the answer. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/** A note without what it says of a person, the signer's name or a phone, and the punctuation before it. */
export function xiongdaRemark(raw: unknown): string {
  const text = clean(raw, 500);
  const at = text.search(PERSONAL);
  return (at >= 0 ? text.slice(0, at) : text).replace(/[\s,，:：;；]+$/u, '');
}

/**
 * The clock a row is written on, from the country and city it gives: a country's when it keeps one, a US
 * state's when the city names a state of one clock. Null for a row without a country, a country of several
 * clocks or a US row without such a state: the row keeps its wall clock alone.
 */
export function xiongdaZone(city: string, country: string): { zone: string; basis: 'place' } | null {
  if (country === 'US') {
    const state = US_PLACE.exec(city)?.[1];
    const zone = state && !SPLIT_STATES.has(state) ? usStateTimeZone(state) : null;
    return zone ? { zone, basis: 'place' } : null;
  }
  const zone = country ? countryTimeZone(country) : null;
  return zone ? { zone, basis: 'place' } : null;
}

/** The order the reply answers for, after the checks that it is this number's. */
function orderOf(body: string, number: string): Json {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`);
  }
  if (!isObject(payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unexpected reply`);
  if (payload.success !== true || cleanScalar(payload.code, 20) !== '0') {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered with an error instead of the order`);
  }
  const orders = isObject(payload.data) ? payload.data.event : undefined;
  if (!Array.isArray(orders) || orders.length !== 1 || !isObject(orders[0])) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an unexpected reply`);
  }
  const order = orders[0];
  const rows = order.eventdetail;
  // An order without rows under the number asked: the tracker holds nothing under it, or no longer does.
  if (rows === null || rows === '' || (Array.isArray(rows) && rows.length === 0)) {
    if (numberOf(order.orderNo) === number) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered without rows for another number`);
  }
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unexpected reply`);
  if (numberOf(order.orderNo) !== number && numberOf(order.referenceNo) !== number) {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered for another number`);
  }
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return order;
}

/** Text the reply holds for a row or the waybill, where it may name UPS and UPS's number. */
function textsOf(order: Json): string[] {
  const rows = (order.eventdetail as unknown[]).filter(isObject);
  const fields = Array.isArray(order.waybillInfoList) ? order.waybillInfoList.filter(isObject) : [];
  return [
    ...rows.flatMap((row) => [row.shipmentNo, row.activity, row.activityEn, row.remark, row.eventDetail, row.eventDetailEn]),
    ...fields.map((field) => field.fieldValue),
  ].map((value) => clean(value, 500)).filter(Boolean);
}

/** UPS and its number, when the reply names UPS and one UPS number, other than the waybill. */
export function xiongdaHandoff(order: Json, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const texts = textsOf(order);
  if (!texts.some((text) => UPS.test(text))) return {};
  const found = new Set(texts.flatMap((text) => [...text.toUpperCase().matchAll(UPS_NUMBER)].map((match) => match[0])));
  const [ups, ...more] = [...found].filter((candidate) => candidate !== number && isValidUpsTrackingNumber(candidate));
  return ups && !more.length ? { delivery_carrier: 'ups', delivery_tracking_number: ups } : {};
}

/** The country the waybill says it flies to, as an ISO code. */
function destinationOf(order: Json): string | null {
  const fields = Array.isArray(order.waybillInfoList) ? order.waybillInfoList.filter(isObject) : [];
  const value = clean(fields.find((field) => field.fieldName === 'destinationCountry')?.fieldValue, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(value) && countryCode(value) === value ? value : null;
}

/**
 * Xiong Da's history for one waybill, newest first: the reply of `/ajax/jiekou.aspx?status=chaxunnew`, which
 * names the waybill it answers for and lists the rows under it, newest first, each a wall clock without its
 * zone. The firm writes its rows in China and in the United States, and copies UPS's scans once UPS has the
 * cartons. A row's country, and a US row's state, give its zone; any other row keeps its wall clock alone.
 */
export function parseXiongda(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeXiongdaNumber(raw);
  const order = orderOf(body, number);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of order.eventdetail as unknown[]) {
    if (!isObject(row)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    const local = wallClock(row.eventTime);
    const code = cleanScalar(row.code, 20);
    const description = [clean(row.activity, 200), xiongdaRemark(row.remark)].filter(Boolean).join(' ');
    if (!description) continue;
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const country = clean(row.country, 8).toUpperCase();
    const city = clean(row.city, 80);
    const town = NO_CITY.test(city) ? '' : city;
    const location = [town, country].filter(Boolean).join(', ');
    const zoned = xiongdaZone(town, country);
    const instant = zoned && firstOccurrence(DateTime.fromISO(local, { zone: zoned.zone }));
    const staged = xiongdaStage(code, description);
    events.push({
      ...(zoned && instant && instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zoned.zone, time_zone_basis: zoned.basis } : {}),
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const destination = destinationOf(order);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    ...xiongdaHandoff(order, number),
    events,
  };
}
