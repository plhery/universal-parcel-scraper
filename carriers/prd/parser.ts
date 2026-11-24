import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { isJAndTGermanyCopy, J_AND_T_GERMANY_COPY_OFFSET } from '../j-and-t-de/copies.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { prdStage } from './status.js';

export const PROVIDER = 'Prime Express';
export const PRD_MAX_BYTES = RTB56_MAX_BYTES;

// PRD and thirteen digits.
const NUMBER = /^PRD\d{13}$/;
const REFERENCE = /^[A-Z0-9]{6,40}$/;
// The networks the line was seen handing parcels to, which their own rules claim whole.
const PARTNERS: ReadonlySet<string> = new Set(['j-and-t-de']);
const MAX_EVENTS = 100;

/**
 * A row J&T Express Germany wrote, which the tracker copies in German once the parcel is handed to it: its wall
 * clock is on the offset those copies keep, an hour behind UTC, not on the clock of the German place it names.
 */
function jAndTGermanyClock(event: CarrierEvent): CarrierEvent {
  const instant = event.local_time && isJAndTGermanyCopy(event.description ?? '')
    ? explicitOffsetTime(`${event.local_time}${J_AND_T_GERMANY_COPY_OFFSET}`) : null;
  if (!instant) return event;
  const dated: CarrierEvent = { time: instant.iso, ...event };
  delete dated.local_time;
  return dated;
}

/** A Prime Express parcel number; anything else is not one its tracker is asked about. */
export function normalizePrdNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Prime Express parcel numbers are PRD and thirteen digits');
  return number;
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock
 * without an offset, a place and English wording. Only the entry whose
 * `server_hawbcode` is the whole number asked is read. The merchant's order
 * reference, the proof of delivery and whoever signed are never read.
 * `channel_hawbcode` is the delivering network's number.
 */
export function parsePrd(payload: unknown, raw: string): CarrierResult {
  const number = normalizePrdNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows, PROVIDER, prdStage, { offsets: false }).map(jAndTGermanyClock);
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  const handedTo = REFERENCE.test(channel) && channel !== number ? channel : '';
  const detected = handedTo ? detectCarrierMatch(handedTo) : undefined;
  const partner = detected?.confidence === 'high' && PARTNERS.has(detected.carrier) ? detected.carrier : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time ?? null,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(handedTo ? { delivery_tracking_number: handedTo } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
