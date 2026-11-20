import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { statusMap, ywdStage } from './status.js';

export const PROVIDER = 'YWD';
export const CARRIER = 'ywd';
export const YWD_MAX_BYTES = RTB56_MAX_BYTES;
// YT, digits and YT; the public waybill has fourteen digits, the first four its year.
const NUMBER = /^YT\d{10,16}YT$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;

/** A YWD waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeYwdNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'YWD waybills are YT, digits and YT');
  return number;
}

/**
 * The reply of YWD's `Service.ashx` lookup on the rtb56 platform: an entry
 * per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference and whoever signed never are. `channel_hawbcode` is the delivering
 * network's number once the line gives one.
 */
export function parseYwd(payload: unknown, raw: string): CarrierResult {
  const number = normalizeYwdNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // Every row states +08:00, the scans at the destination too, so rows keep their wall clocks.
  const events = rtb56Scans(rows, PROVIDER, ywdStage, { offsets: false, codes: true });
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
