import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { calendarDay, countryCode, countryTimeZone, zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { PROVIDER } from './parser.js';
import { classifyHongkongPostStatus } from './status.js';

const MAX_EVENTS = 200;
const CLOCK = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;

/**
 * The zone of a scan's place. The tracker gives each scan the local time where it happened
 * and names that place by its country. Hong Kong is its own scans' place; a country of
 * several zones gives none.
 */
function placeZone(place: string): string | null {
  return place === 'HONG KONG' ? 'Asia/Hong_Kong' : countryTimeZone(place);
}

function eventOf(value: unknown): CarrierEvent {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Hongkong Post returned an unreadable scan');
  const clock = CLOCK.exec(clean(value.date, 32));
  const description = clean(value.message, 300);
  const place = clean(value.location_name, 100);
  if (!clock || !description) throw new SchemaError(PROVIDER, 'Hongkong Post returned an unreadable scan');
  const [, day, month, year, hour, minute] = clock;
  const date = calendarDay(Number(year), Number(month), Number(day));
  if (!date || Number(hour) > 23 || Number(minute) > 59) throw new SchemaError(PROVIDER, 'Hongkong Post returned an invalid scan clock');
  const local_time = `${date}T${hour}:${minute}:00`;
  const zone = place ? placeZone(place) : null;
  const instant = zone ? zonedTime(local_time, "yyyy-MM-dd'T'HH:mm:ss", zone) : null;
  const classified = classifyHongkongPostStatus(description);
  return { local_time, ...(instant ? { time: instant.iso, time_zone: zone!, time_zone_basis: 'place' } : {}),
    ...(place ? { location: place } : {}), description,
    ...(classified.stage ? { stage: classified.stage, stage_source: classified.source } : {}) };
}

/**
 * The tracker's answer for one item. `check_auth` says whether it took the
 * verification token; the item is keyed and labelled by its number.
 */
export function parseHongkongPostHistory(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Hongkong Post returned an unreadable reply');
  if (payload.check_auth !== true || payload.captcha_null === true) throw new ChallengeError(PROVIDER, 'Hongkong Post refused the verification token');
  if (payload.catchWebException === true) throw new IndeterminateError(PROVIDER, 'Hongkong Post could not read its tracking records');
  const items = isRecord(payload.items) ? payload.items : null;
  const item = items && Object.keys(items).length === 1 ? items[number] : null;
  if (!isRecord(item) || item.itemNo !== number) throw new SchemaError(PROVIDER, 'Hongkong Post answered for another item');
  if (item.result === '-1') throw new NotFoundError(PROVIDER);
  if (item.result !== '0') throw new IndeterminateError(PROVIDER, 'Hongkong Post gave an unknown answer for the item');
  // A found item without its scans leaves the chatbot's summary to answer.
  if (item.detail_flag !== true || !Array.isArray(item.event) || !item.event.length) {
    throw new IndeterminateError(PROVIDER, 'Hongkong Post found the item without its history');
  }
  if (item.event.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Hongkong Post returned an excessive history');
  // The tracker lists the oldest scan first.
  const events = item.event.map(eventOf).reverse();
  const newest = events[0]!;
  const destination = countryCode(clean(item.dest_country, 8));
  const service = clean(item.mail_type_desc, 100);
  return {
    status: classifyHongkongPostStatus(newest.description!).status,
    ...(newest.stage ? { current_stage: newest.stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description!, last_update: newest.time ?? null, last_update_local: newest.local_time!,
    expected_delivery: null, ...(service ? { service_name: service } : {}),
    ...(destination && destination !== 'HK' ? { destination_country: destination } : {}), events,
  };
}
