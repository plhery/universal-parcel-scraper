import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { huayutongStage, statusMap } from './status.js';

export const PROVIDER = 'Huayutong';
export const CARRIER = 'huayutong';
export const HUAYUTONG_MAX_BYTES = RTB56_MAX_BYTES;
// JCY, ten digits and DH, the one layout seen.
const NUMBER = /^JCY\d{10}DH$/;
const ONWARD = /^[A-Z0-9]{6,40}$/;

/** A Huayutong waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeHuayutongNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Huayutong waybills are JCY, ten digits and DH');
  return number;
}

/**
 * The reply of Huayutong's `Service.ashx` lookup on the rtb56 platform: an
 * entry per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's order
 * reference, the proof of delivery and whoever signed never are.
 * `channel_hawbcode` is the delivering network's number once the line gives
 * one. A bare `null`, which another tenant of the platform answers a request
 * that names a referring page, proves nothing.
 */
export function parseHuayutong(payload: unknown, raw: string): CarrierResult {
  const number = normalizeHuayutongNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'Huayutong answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  // Every row states +08:00, those placed in Britain too, whose delivery round would then come before dawn there,
  // so rows keep their wall clocks.
  const events = rtb56Scans(rows, PROVIDER, huayutongStage, { offsets: false });
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
