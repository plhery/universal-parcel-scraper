import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, usZipState } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { muserStage } from './status.js';

export const PROVIDER = 'Muser International Logistics';
export const MUSER_MAX_BYTES = RTB56_MAX_BYTES;

// MS, fourteen digits and YD.
const NUMBER = /^MS\d{14}YD$/;
// A delivering network's scan leaves the place empty and follows its wording with its town and
// ZIP Code, past a run of spaces.
const TRAILING_PLACE = /^(\S.*?)\s{3,}(\S.*)$/s;
const TOWN_ZIP = /^(.*?\S)[\s,]+(\d{5})(?:-\d{4})?$/;
const MAX_EVENTS = 100;

/** A Muser parcel number; anything else is not one its tracker is asked about. */
export function normalizeMuserNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Muser parcel numbers are MS, fourteen digits and YD');
  return number;
}

/** A delivering network's scan with its town as the place, in its state when the parcel goes to the United States. */
function placedScan(row: unknown, country: string | null): unknown {
  if (!isRecord(row) || rtb56Text(row, 'track_location', PROVIDER, 120)) return row;
  const text = (key: string) => typeof row[key] === 'string' ? row[key].trim() : '';
  const place = (TRAILING_PLACE.exec(text('track_description_en')) ?? TRAILING_PLACE.exec(text('track_description')))?.[2];
  if (!place) return row;
  const wording = (key: string) => {
    const own = TRAILING_PLACE.exec(text(key));
    return own?.[2] === place ? own[1] : row[key];
  };
  const town = country === 'US' ? TOWN_ZIP.exec(place) : null;
  const state = town ? usZipState(town[2]) : null;
  return { ...row, track_location: state ? `${town![1]}, ${state}` : place,
    track_description_en: wording('track_description_en'), track_description: wording('track_description') };
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with the scans newest first, each a wall clock,
 * an offset, a place and English wording. Only the entry whose
 * `server_hawbcode` is the whole number asked is read. The merchant's order
 * reference, the proof of delivery and the signatory are never read.
 */
export function parseMuser(payload: unknown, raw: string): CarrierResult {
  const number = normalizeMuserNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  // The tracker states China's offset on every scan, the delivering network's in its own town too,
  // so each scan keeps its wall clock.
  const events = rtb56Scans(rows.map((row) => placedScan(row, country)), PROVIDER, muserStage, { offsets: false });
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
