import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { ywbzStage } from './status.js';

export const PROVIDER = 'YWBZ Express';
export const YWBZ_MAX_BYTES = RTB56_MAX_BYTES;

// YWBZ and ten digits.
const NUMBER = /^YWBZ\d{10}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
// The scan that hands the parcel to another network names its number.
const HANDED_OVER = /\bnew tracking number is ([A-Z0-9]{4,40})\b/i;
// The networks the line was seen handing parcels to, which their own rules claim whole.
const PARTNERS: ReadonlySet<string> = new Set(['swiftx', 'ywe']);
const MAX_EVENTS = 100;

/** A YWBZ Express parcel number; anything else is not one its tracker is asked about. */
export function normalizeYwbzNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YWBZ Express parcel numbers are YWBZ and ten digits');
  return number;
}

/** A delivering network's scan without the place it opens with, which the scan's place repeats. */
function ownWording(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const place = rtb56Text(row, 'track_location', PROVIDER, 120);
  const wording = (key: string) => {
    const text = rtb56Text(row, key, PROVIDER, 1000);
    return place && text.startsWith(`${place}, `) ? text.slice(place.length + 2) : text;
  };
  return { ...row, track_description_en: wording('track_description_en'), track_description: wording('track_description') };
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock,
 * an offset when the line states one, a place and English wording. Only the
 * entry whose `server_hawbcode` is the whole number asked is read. The
 * merchant's order reference and the proof of delivery are never read, nor the
 * signatory field, which holds no name.
 */
export function parseYwbz(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYwbzNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows.map(ownWording), PROVIDER, ywbzStage, { offsets: true });
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  // The delivering network's number: the record's, else the one the newest hand-over scan names.
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64))
    || normalizeTrackingNumber(events.map((event) => HANDED_OVER.exec(event.description ?? '')?.[1] ?? '').find(Boolean) ?? '');
  const handedTo = REFERENCE.test(channel) && channel !== number ? channel : '';
  const detected = handedTo ? detectCarrierMatch(handedTo) : undefined;
  const partner = detected?.confidence === 'high' && PARTNERS.has(detected.carrier) ? detected.carrier : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(handedTo ? { delivery_tracking_number: handedTo } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
