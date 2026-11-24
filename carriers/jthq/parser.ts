import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasGs1CheckDigit } from '../../core/detection/numericChecksums.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { jthqStage, statusMap } from './status.js';

export const PROVIDER = 'JTHQ';
export const CARRIER = 'jthq';
export const JTHQ_MAX_BYTES = RTB56_MAX_BYTES;
// JTHQ and twelve digits.
const NUMBER = /^JTHQ\d{12}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// Canada Post's sixteen-digit parcel numbers, with their GS1 check digit, which other carriers' lengths share: the
// line to Canada hands its parcels to Canada Post, whose scans the tracker copies.
const CANADA_POST = /^\d{16}$/;

/** A JTHQ waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeJthqNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'JTHQ waybills are JTHQ and twelve digits');
  return number;
}

/** The carrier that delivers under the line's onward number: USPS when its rule claims it whole, Canada Post on the line to Canada. */
function partnerOf(onward: string, country: string): string | undefined {
  if (country === 'CA' && CANADA_POST.test(onward) && hasGs1CheckDigit(onward)) return 'canada-post';
  const detected = detectCarrierMatch(onward);
  return detected.confidence === 'high' && detected.carrier === 'usps' ? 'usps' : undefined;
}

/**
 * The reply of JTHQ's `Service.ashx` lookup on the rtb56 platform: an entry per
 * number, with the scans newest first, each stating its offset. Only the entry
 * whose `server_hawbcode` is the whole number asked is read; the merchant's
 * order reference, the proof of delivery and whoever signed never are.
 * `channel_hawbcode` is the delivering network's number. A bare `null` is what
 * the lookup answers any request that names a referring page, a parcel's as an
 * unknown number's: it proves nothing.
 */
export function parseJthq(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJthqNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'JTHQ answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // JTHQ's own scans state +08:00, the delivering network's their own place's offset.
  const events = rtb56Scans(rows, PROVIDER, jthqStage, { offsets: true });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const given = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  // A USPS routing barcode opens with the recipient's ZIP code; the package identifier after it is the number USPS tracks.
  const channel = USPS_ROUTING_BARCODE.test(given) ? uspsPackageIdentifier(given) ?? '' : given;
  const onward = ONWARD.test(channel) && channel !== number ? channel : '';
  const partner = onward ? partnerOf(onward, country ?? '') : undefined;
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
