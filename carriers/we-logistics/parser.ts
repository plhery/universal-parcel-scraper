import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { statusMap, weLogisticsStage } from './status.js';

export const PROVIDER = 'WE Logistics';
export const CARRIER = 'we-logistics';
export const WE_LOGISTICS_MAX_BYTES = RTB56_MAX_BYTES;
// WEL, two letters, ten digits and YQ, the one layout seen.
const NUMBER = /^WEL[A-Z]{2}\d{10}YQ$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;

/** A WE Logistics waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeWeLogisticsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'WE Logistics waybills are WEL, two letters, ten digits and YQ');
  return number;
}

/**
 * The reply of WE Logistics's `Service.ashx` lookup on the rtb56 platform: an
 * entry per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference, the proof of delivery and whoever signed never are.
 * `channel_hawbcode` is the number of the line abroad, which the reply ties to
 * no carrier. A bare `null`, which another tenant of the platform answers a
 * request that names a referring page, proves nothing.
 */
export function parseWeLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWeLogisticsNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'WE Logistics answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // The line's own rows in Shenzhen state +08:00 and get their instant; the rows of the line abroad, at Hong Kong and
  // in Israel, state no offset and keep their wall clocks.
  const events = rtb56Scans(rows, PROVIDER, weLogisticsStage, { offsets: true });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  const channel = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(ONWARD.test(channel) && channel !== number ? { delivery_tracking_number: channel } : {}),
    events,
  };
}
