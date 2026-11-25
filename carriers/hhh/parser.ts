import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { hhhStage, statusMap } from './status.js';

export const PROVIDER = 'Haihehui International';
export const CARRIER = 'hhh';
export const HHH_MAX_BYTES = RTB56_MAX_BYTES;
// HHH, ten digits and YQ, the one layout seen.
const NUMBER = /^HHH\d{10}YQ$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// USPS's sentence after its status ("Delivered, Front Door/Porch -> Your item was delivered … in TOWN, ST 00000."),
// which repeats the scan's clock and place and names the recipient's ZIP code.
const SENTENCE = /\s+->\s[\s\S]*$/;
// The delivering networks the line was seen handing parcels to, named when their rule claims the number whole.
const PARTNERS = new Set(['usps', 'uniuni']);

/** A Haihehui International waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeHhhNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Haihehui International waybills are HHH, ten digits and YQ');
  return number;
}

/** A scan without the sentence USPS writes after its status. */
function withoutSentence(row: unknown): unknown {
  if (!isRecord(row)) return row;
  const wording = (key: string) => rtb56Text(row, key, PROVIDER, 1000).replace(SENTENCE, '');
  return { ...row, track_description_en: wording('track_description_en'), track_description: wording('track_description') };
}

/**
 * The reply of Haihehui International's `Service.ashx` lookup on the rtb56
 * platform: an entry per number, with the scans newest first. Only the entry
 * whose `server_hawbcode` is the whole number asked is read; the merchant's
 * order reference, the proof of delivery and whoever signed never are.
 * `channel_hawbcode` is the delivering network's number. A bare `null`, which
 * another tenant of the platform answers a request that names a referring page,
 * proves nothing.
 */
export function parseHhh(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHhhNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'Haihehui International answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // The line's own rows state +08:00, some at the destination too, and the copied ones an offset that can miss
  // the place's daylight saving, so rows keep their wall clocks.
  const events = rtb56Scans(rows.map(withoutSentence), PROVIDER, hhhStage, { offsets: false });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const given = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  // A USPS routing barcode opens with the recipient's ZIP code; the package identifier after it is the number USPS tracks.
  const channel = USPS_ROUTING_BARCODE.test(given) ? uspsPackageIdentifier(given) ?? '' : given;
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
