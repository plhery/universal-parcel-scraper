import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { statusMap, wcxexStage } from './status.js';

export const PROVIDER = 'WCXEX';
export const CARRIER = 'wcxex';
export const WCXEX_MAX_BYTES = RTB56_MAX_BYTES;
// WX, a digit, a letter and twelve digits, the one layout seen.
const NUMBER = /^WX\d[A-Z]\d{12}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;
// The delivering networks the line was seen handing parcels to, named when their rule claims the number whole.
const PARTNERS: ReadonlySet<string> = new Set(['speedx']);

// The platform's own zone, which the line's rows state, each with its code.
const PLATFORM_OFFSET = '+08:00';

/**
 * Whether a row's stated offset is believed. The line's own rows state +08:00 and carry a `track_code`,
 * and get their instant, at its US gateways too: on that clock the flights from Hong Kong take the 16 to
 * 18 hours of a cargo routing. USPS's copies at Los Angeles state +08:00 without a code, and there it is
 * the platform's zone used as a label: the other rtb56 tenants keep USPS's own offset where the feed
 * gives one (Georgia's, Kentucky's, New York's), on which their USPS rows go out for delivery early in
 * the morning and deliver in the afternoon; this line's other USPS copies label Houston and Arizona
 * `America/New_York`; and the four Los Angeles rows were copied in one batch after the delivery, their
 * row ids within about 36k of each other while the line's own rows advance some 50k to 130k an hour,
 * though the scans span two days. Read on +08:00 the delivery falls at 01:01 in Los Angeles. Against
 * this, read as Los Angeles's wall clock the parcel goes out for delivery at 02:21. Such a row keeps
 * its wall clock, which the tracker reads in its place's zone; any other signed offset is believed.
 */
const offsetBelieved = (row: Record<string, unknown>): boolean => rtb56Text(row, 'gmt_offset', PROVIDER, 16) !== PLATFORM_OFFSET
  || (typeof row.track_code === 'string' && row.track_code.trim() !== '');

/** A WCXEX waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeWcxexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'WCXEX waybills are WX, a digit, a letter and twelve digits');
  return number;
}

/**
 * The reply of WCXEX's `Service.ashx` lookup on the rtb56 platform: an entry
 * per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference, the proof of delivery and whoever signed never are.
 * `channel_hawbcode` is the delivering network's number. A bare `null`, which
 * another tenant of the platform answers a request that names a referring
 * page, proves nothing.
 */
export function parseWcxex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWcxexNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'WCXEX answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // The delivering network's copies state a zone's name, an unsigned offset, the platform's zone without a code,
  // or none, and keep their wall clocks.
  const events = rtb56Scans(rows, PROVIDER, wcxexStage, { offsets: offsetBelieved });
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
