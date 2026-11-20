import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { dpdexStage, statusMap } from './status.js';

export const PROVIDER = 'DpdEx';
export const CARRIER = 'dpdex';
export const DPDEX_MAX_BYTES = RTB56_MAX_BYTES;
// DPE and eleven digits.
const NUMBER = /^DPE\d{11}$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;

/** A DpdEx waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeDpdexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DpdEx waybills are DPE and eleven digits');
  return number;
}

/**
 * The reply of DpdEx's `Service.ashx` lookup on the rtb56 platform: an entry
 * per number, with the scans newest first, each a wall clock. Only the entry
 * whose `server_hawbcode` is the whole number asked is read; the merchant's
 * order reference and whoever signed never are. `channel_hawbcode` is the
 * delivering carrier's number.
 */
export function parseDpdex(payload: unknown, raw: string): CarrierResult {
  const number = normalizeDpdexNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows, PROVIDER, dpdexStage, { offsets: false, codes: true });
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
