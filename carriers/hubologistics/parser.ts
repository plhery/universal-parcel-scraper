import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { countryTimeZone, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { huboStage, statusMap } from './status.js';

export const PROVIDER = 'HUBO Logistics';
export const CARRIER = 'hubologistics';
// An order's route is a few kilobytes.
export const HUBO_MAX_BYTES = 512 * 1024;
// HUBO's order numbers: two letters, the year and month, and a sequence, such as OZ and ten digits or ZD and twelve.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const ZONE = 'Asia/Shanghai';
// "2024-04-24 14:02:39": the clock HUBO's system writes, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A mainland mobile number inside a text is left out.
const MOBILE = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
// A destination in the United States: the town, the state and the ZIP code, after the street or before it.
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR';
const US_TOWN = new RegExp(`(?:^|,)\\s*([A-Za-z][A-Za-z .'-]{0,40}?)\\s*,?\\s+(${US_STATES})\\s+\\d{5}(?:-\\d{4})?(?=[\\s,]|$)`);
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** An order number on HUBO's tracker, in capitals, without spaces or hyphens: the tracker reads it in either case. */
export function normalizeHuboNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HUBO order numbers are 6 to 40 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid route row`);
  return clean(value, maxLength);
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid route time`);
  }
  return local;
}

/**
 * The town and country of a destination address, without the street or the ZIP code: "Fontana, CA" in
 * the United States. Another country's address gives nothing.
 */
export function huboDestination(address: string): { country: string; town: string } | null {
  const match = US_TOWN.exec(address);
  if (!match) return null;
  const town = clean(match[1]!, 40);
  // A town of more words is the street run into it.
  return { country: 'US', town: town.split(' ').length <= 3 ? `${town}, ${match[2]}` : '' };
}

interface Row {
  readonly local: string;
  readonly code: string;
  readonly description: string;
  readonly country: string;
  readonly city: string;
  readonly relayed: boolean;
}

function row(value: unknown, number: string): Row {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid route row`);
  if (value.orderCode !== undefined && value.orderCode !== null
    && (typeof value.orderCode !== 'string' || normalizeTrackingNumber(value.orderCode) !== number)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with another order's route`);
  }
  const code = value.node === null || value.node === undefined ? '' : value.node;
  if (typeof code !== 'string' || !/^\d{0,6}$/.test(code)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid route row`);
  const country = text(value.countryCode, 8).toUpperCase();
  const english = text(value.routingEnContent, 300);
  return {
    local: wallClock(value.routingTime), code,
    description: clean((text(value.routingCnContent, 300) || english).replace(MOBILE, ''), 300),
    country: /^[A-Z]{2}$/.test(country) ? country : '',
    city: text(value.city, 60),
    relayed: english !== '',
  };
}

/**
 * The zone a row's clock is on, and why. HUBO's staff and system write a row at the time they enter it,
 * on China's clock, wherever the place it names: a row about the port of arrival in Long Beach was dated
 * seconds before the system stamped it. A row copied in English from the delivery partner abroad keeps
 * that partner's clock: its place's zone when its country keeps one, else its wall clock alone.
 */
function rowZone(entry: Row): { zone: string; basis: string } | null {
  if (!entry.relayed) return { zone: ZONE, basis: 'carrier' };
  const zone = countryTimeZone(entry.country);
  return zone ? { zone, basis: 'place' } : null;
}

/**
 * HUBO's route for one order, newest first: the reply of `orderInfo/{order}`, `{code, msg, data}`, whose
 * `data` holds the order (its number, channel, totals and destination warehouse) and `routeList`, its rows
 * newest first. A row gives a clock without a zone, a Chinese text, and on newer rows a node code, a country
 * and a city. The staff who wrote each row, the pictures a delivery links and the destination's street and
 * ZIP code are left out.
 */
export function parseHubo(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHuboNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== 200) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  // The service's answer for an order it does not hold: success, with no order.
  if (payload.data === null || payload.data === undefined) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
  const order = payload.data;
  if (!isRecord(order) || typeof order.orderCode !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid order`);
  if (normalizeTrackingNumber(order.orderCode) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered with another order`);
  const list = order.routeList ?? [];
  if (!Array.isArray(list)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid route`);
  if (list.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized route`);
  const seen = new Set<string>();
  const rows: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, entry] of (list as unknown[]).map((value) => row(value, number)).entries()) {
    if (!entry.description) continue;
    const key = JSON.stringify([entry.local, entry.code, entry.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const zoned = rowZone(entry);
    const instant = zoned ? firstOccurrence(DateTime.fromISO(entry.local, { zone: zoned.zone })) : null;
    const location = [entry.city, entry.country].filter(Boolean).join(', ');
    const stage = huboStage(entry.code || null, normalizeStatusWording(entry.description));
    rows.push({ local: entry.local, index, event: {
      ...(instant && instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zoned!.zone, time_zone_basis: zoned!.basis } : {}),
      local_time: entry.local,
      ...(location ? { location } : {}),
      description: entry.description,
      ...(entry.code ? { provider_code: entry.code } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows at one clock keep the reply's order, which lists the newer first.
  const events = rows.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((entry) => entry.event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const current = staged?.stage as Stage | undefined;
  const destination = huboDestination(text(order.destAddress, 200));
  const service = text(order.customerChannelName, 80);
  const weight = typeof order.totalWeight === 'number' && Number.isFinite(order.totalWeight) && order.totalWeight > 0
    ? order.totalWeight : null;
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current ? { current_stage: current, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(destination ? { destination_country: destination.country } : {}),
    ...(destination?.town ? { receiver_address: destination.town } : {}),
    ...(service ? { service_name: service } : {}),
    ...(weight !== null ? { weight_kg: weight } : {}),
    events,
  };
}
