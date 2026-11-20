import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { sheensyncStage, statusMap } from './status.js';

export const PROVIDER = 'SheenSync';
export const CARRIER = 'sheensync';
export const SHEENSYNC_MAX_BYTES = RTB56_MAX_BYTES;
// The tracking page's own check: SS and twelve digits.
const NUMBER = /^SS\d{12}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// The place of a scan the forwarder's system files by itself, which names none.
const NO_PLACE = /^system$/i;

/** A SheenSync waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeSheensyncNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SheenSync waybills are SS and twelve digits');
  return number;
}

/**
 * The reply of the tracking page's `/api/track` lookup, in the rtb56 platform's
 * shape: an entry per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference never is. `channel_hawbcode` is the line's own number for the parcel.
 */
export function parseSheensync(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSheensyncNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // Every scan states +08:00, the American ones too, whose clocks follow a delivery day there: wall clocks.
  const placed = rows.map((row) => (isRecord(row) && typeof row.track_location === 'string' && NO_PLACE.test(row.track_location.trim())
    ? { ...row, track_location: '' } : row));
  const events = rtb56Scans(placed, PROVIDER, sheensyncStage, { offsets: false, codes: true });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const onward = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(ONWARD.test(onward) && onward !== number ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
