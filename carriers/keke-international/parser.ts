import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { kekeStage, statusMap } from './status.js';

export const PROVIDER = 'Keke International';
export const CARRIER = 'keke-international';
export const KEKE_MAX_BYTES = RTB56_MAX_BYTES;
// The line's own waybill, KK and eight digits, or the delivering network's number, which the lookup finds too.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// The delivering networks the line was seen handing parcels to, named when their rule claims the number whole.
const PARTNERS: ReadonlySet<string> = new Set(['team-global-express']);
// Team Global Express's feed lists a category beside each of its scans, at the scan's clock and place:
// "Delivered" beside "Successful delivery", "Out for delivery" beside "On for delivery".
const CATEGORIES: ReadonlySet<string> = new Set(['delivered', 'out for delivery', 'in transit', 'shipment created']);

/** A number Keke International's lookup can be asked for, without spaces or hyphens. */
export function normalizeKekeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Keke International tracks its own waybills and the delivering network\'s numbers');
  return number;
}

const code = (item: Record<string, unknown>, key: string): string =>
  typeof item[key] === 'string' ? normalizeTrackingNumber(item[key]) : '';

/**
 * The line's waybill the reply holds for the number asked: the number itself when it is the waybill
 * of an entry, else the waybill of the one entry whose delivering network's number it is.
 */
function waybillOf(payload: unknown, number: string): string {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return number;
  const entries = payload.data.filter(isRecord);
  if (entries.some((item) => code(item, 'server_hawbcode') === number)) return number;
  const carried = entries.filter((item) => code(item, 'channel_hawbcode') === number);
  return carried.length === 1 ? code(carried[0]!, 'server_hawbcode') || number : number;
}

const wording = (row: Record<string, unknown>): string =>
  normalizeStatusWording(rtb56Text(row, 'track_description_en', PROVIDER) || rtb56Text(row, 'track_description', PROVIDER));
const at = (row: Record<string, unknown>): string => JSON.stringify([row.track_occur_date, row.track_location]);

/** The rows without a category Team Global Express lists beside a scan at its clock and place. */
function withoutCategories(rows: unknown[]): unknown[] {
  const records = rows.filter(isRecord);
  const scans = new Set(records.filter((row) => !CATEGORIES.has(wording(row))).map(at));
  return rows.filter((row) => !isRecord(row) || rtb56Text(row, 'track_code', PROVIDER, 16)
    || !CATEGORIES.has(wording(row)) || !scans.has(at(row)));
}

/**
 * The reply of Keke International's `Service.ashx` lookup on the rtb56 platform: an entry per
 * parcel, with the scans newest first. The lookup finds a parcel by the line's waybill, by the
 * merchant's reference and by the delivering network's number; only the entry whose
 * `server_hawbcode` or `channel_hawbcode` is the whole number asked is read, and the merchant's
 * reference, the proof of delivery and whoever signed never are. A bare `null`, which another tenant
 * of the platform answers a request that names a referring page, proves nothing.
 */
export function parseKeke(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKekeNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'Keke International answered the lookup with null');
  const waybill = waybillOf(payload, number);
  const { item, rows } = rtb56Entry(payload, waybill, PROVIDER);
  // The line's own rows state +08:00 and Team Global Express's +10:00, at a place in China too: the offset follows
  // the network's clock rather than the place, and may miss daylight saving, so rows keep their wall clocks.
  const events = rtb56Scans(withoutCategories(rows), PROVIDER, kekeStage, { offsets: false });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  const onward = ONWARD.test(channel) && channel !== waybill ? channel : '';
  const detected = onward ? detectCarrierMatch(onward) : undefined;
  const partner = detected?.confidence === 'high' && PARTNERS.has(detected.carrier) ? detected.carrier : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(waybill !== number ? { canonical_tracking_number: waybill } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(partner ? { delivery_carrier: partner } : {}),
    ...(onward && onward !== number ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
