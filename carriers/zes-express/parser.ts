import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZesExpressReference } from '../../core/detection/zesExpress.js';
import { IndeterminateError, InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { RTB56_MAX_BYTES, rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { zesExpressStage } from './status.js';

export const PROVIDER = 'ZES Express';
export const ZES_MAX_BYTES = RTB56_MAX_BYTES;

/** Recipient/signature fields appended to Russian tracking prose are not a milestone. */
function safeWording(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/(?:^|\s*[,;:—–-]\s*|\s+)(?:получатель|получил[а]?|фио\s+получателя|подпись)\s*[:：].*$/iu, '').trim() : value;
}

export function normalizeZesExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isZesExpressReference(number)) throw new InvalidInputError(PROVIDER, 'ZES Express requires its forwarding waybill');
  return number;
}

/** The carrier-linked tenant may also resolve merchant references; only its primary whole identity establishes this parcel. */
export function parseZesExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZesExpressNumber(raw);
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));
  if (country !== 'RU') throw new IndeterminateError(PROVIDER, 'ZES Express did not identify its Russian delivery network');
  // Preserve offsets the carrier explicitly states, even when their geography is surprising.
  // Unlabelled rows keep local clocks, in the API's order across the onward networks.
  const safeRows = rows.map(row => isRecord(row) ? { ...row,
    track_description: safeWording(row.track_description), track_description_en: safeWording(row.track_description_en),
  } : row);
  const events = rtb56Scans(safeRows, PROVIDER, zesExpressStage, { offsets: true, codes: true });
  const latest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const onward = normalizeTrackingNumber(rtb56Text(item, 'channel_hawbcode', PROVIDER, 64));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}), expected_delivery: null,
    destination_country: country,
    ...(/^[A-Z0-9]{4,40}$/.test(onward) && onward !== number ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
