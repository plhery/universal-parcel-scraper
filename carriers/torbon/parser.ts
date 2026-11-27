import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { statusMap, torbonStage } from './status.js';

export const PROVIDER = 'Torbon';
export const CARRIER = 'torbon';
export const TORBON_MAX_BYTES = RTB56_MAX_BYTES;
// TB, ten digits and CN, the one layout seen.
const NUMBER = /^TB\d{10}CN$/;

/** A Torbon waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeTorbonNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Torbon waybills are TB, ten digits and CN');
  return number;
}

/**
 * The reply of Torbon's `Service.ashx` lookup on the rtb56 platform: an entry
 * per number, with the scans newest first. Only the entry whose
 * `server_hawbcode` is the whole number asked is read; the merchant's
 * reference and the proof of delivery never are. Every scan states `+08:00`,
 * those its staff type for the port and the warehouse in the United States
 * too: they are typed on China's clock, so each scan gets its instant.
 */
export function parseTorbon(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTorbonNumber(raw);
  if (payload === null) throw new IndeterminateError(PROVIDER, 'Torbon answered the lookup with null');
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const events = rtb56Scans(rows, PROVIDER, torbonStage, { offsets: true, codes: true });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
