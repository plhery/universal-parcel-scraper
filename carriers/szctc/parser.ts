import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { withoutGofoSupportLine } from '../gofo/support.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { statusMap, szctcStage } from './status.js';

export const PROVIDER = 'CTC Supply Chain';
export const CARRIER = 'szctc';
export const SZCTC_MAX_BYTES = RTB56_MAX_BYTES;
// CTC and twelve digits.
const NUMBER = /^CTC\d{12}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// The networks the line was seen handing parcels to, which their own rules claim whole.
const PARTNERS: ReadonlySet<string> = new Set(['gofo']);

/** A CTC Supply Chain waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeSzctcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CTC Supply Chain waybills are CTC and twelve digits');
  return number;
}

/** A scan without the support line GOFO appends to some of its scans, naming GOFO's phone and email. */
function withoutSupportLine(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const wording = (key: string) => withoutGofoSupportLine(rtb56Text(row, key, PROVIDER, 1000));
  return { ...row, track_description_en: wording('track_description_en'), track_description: wording('track_description') };
}

/**
 * The reply of CTC Supply Chain's `Service.ashx` lookup on the rtb56 platform:
 * an entry per number, with the scans newest first, each stating its offset.
 * Only the entry whose `server_hawbcode` is the whole number asked is read; the
 * merchant's order reference, the proof of delivery and whoever signed never
 * are. `channel_hawbcode` is the delivering network's number. A bare `null`,
 * which another tenant of the platform answers a request that names a referring
 * page, proves nothing.
 */
export function parseSzctc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSzctcNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'CTC Supply Chain answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // The line's scans in China state +08:00, those in the United States their place's offset.
  const events = rtb56Scans(rows.map(withoutSupportLine), PROVIDER, szctcStage, { offsets: true });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  const onward = ONWARD.test(channel) && channel !== number ? channel : '';
  const detected = onward ? detectCarrierMatch(onward) : undefined;
  const partner = detected?.confidence === 'high' && PARTNERS.has(detected.carrier) ? detected.carrier : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(onward ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
