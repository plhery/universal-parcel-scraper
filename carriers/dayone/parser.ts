import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { dayoneCodeStage, dayoneStage } from './status.js';

export const PROVIDER = 'DayOne';
export const DAYONE_MAX_BYTES = RTB56_MAX_BYTES;

// DOT and sixteen digits.
const NUMBER = /^DOT\d{16}$/;
const REFERENCE = /^[A-Z0-9]{4,40}$/;
const MAX_EVENTS = 100;
// The ERP's scan clock: China's wall clock, written as if it were UTC.
const ERP_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})Z$/;

/** A DayOne parcel number; anything else is not one it issues. */
export function normalizeDayoneNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DayOne parcel numbers are DOT and sixteen digits');
  return number;
}

/** An ERP scan with its clock as the tracker writes it; any other clock is left for the scan reader to refuse. */
function erpScan(row: unknown): unknown {
  if (!isRecord(row) || typeof row.track_occur_date !== 'string') return row;
  const match = ERP_CLOCK.exec(row.track_occur_date);
  return match ? { ...row, track_occur_date: `${match[1]} ${match[2]}` } : row;
}

/**
 * The reply of the tracker's `Service.ashx` lookup for one number: `data`
 * holds an entry per number, with its summary status as a code and the
 * network's scans, newest wall clock first, each with the offset of its
 * place. A number the tracker does not know gets `success` 0 and its "No
 * query to track information" message. Only the entry whose
 * `server_hawbcode` is the whole number asked is read. A delivered parcel's
 * `signatory_name` is who took it; the merchant's order reference and the
 * proof of delivery are not read.
 * With `erp`, the reply is the ERP's for a DOT1 number: the same shape as
 * JSON, without offsets, its clocks China's wall clocks marked as UTC.
 */
export function parseDayone(payload: unknown, raw: string, { erp = false }: { erp?: boolean } = {}): CarrierResult {
  const number = normalizeDayoneNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = erp
    ? rtb56Scans(rows.map(erpScan), PROVIDER, dayoneStage, { offsets: false })
    : rtb56Scans(rows, PROVIDER, dayoneStage, { offsets: true });
  const newest = events[0]!;
  // The destination post's manifest, relayed after the parcel moved, is no step back. The
  // summary's status decides only when no scan has a stage.
  const scanned = events.find((event) => event.stage && event.stage !== 'registered') ?? events.find((event) => event.stage);
  const code = rtb56Text(item, 'track_status', PROVIDER, 8).toUpperCase();
  const stage = (scanned?.stage ?? dayoneCodeStage(code)) as Stage | undefined;
  const destination = rtb56Text(item, 'destination_country', PROVIDER, 8);
  const destinationName = rtb56Text(item, 'destination_country_enname', PROVIDER, 80);
  const country = countryCode(destination) ?? countryCode(destinationName);
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  const signatory = stage === 'delivered' ? clean(item.signatory_name, 120) : '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: scanned?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    ...(stage === 'delivered' && scanned?.time ? { delivered_at: scanned.time } : {}),
    ...(signatory ? { signed_by: signatory } : {}),
    ...(country ? { destination_country: country } : destinationName ? { destination_country_name: destinationName } : {}),
    // The network's own number for the parcel; the hand-off decides who that is.
    ...(REFERENCE.test(channel) && channel !== number ? { delivery_tracking_number: channel } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
