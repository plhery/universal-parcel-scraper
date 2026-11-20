import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { itdidaDestination, itdidaEntry, itdidaOnward, itdidaScans, ITDIDA_MAX_BYTES } from './itdida.js';
import { statusMap, whwdtStage } from './status.js';

export const PROVIDER = 'Wuhan Wodetong';
export const CARRIER = 'whwdt';
export const WHWDT_MAX_BYTES = ITDIDA_MAX_BYTES;
// The forwarder's waybills seen so far: a letter, twelve digits and a letter.
const NUMBER = /^[A-Z]\d{12}[A-Z]$/;

/** A Wodetong waybill, without spaces or hyphens. Anything else is not a number its tenant issues. */
export function normalizeWhwdtNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Wuhan Wodetong waybills are a letter, twelve digits and a letter');
  return number;
}

/**
 * The reply of the tenant's `queryTracks` lookup. The waybill names its
 * destination and, once handed on, the onward carrier's number. Its scans
 * come from the warehouse in Shenzhen, the line haul and the delivering
 * carrier, each in its own place's wall clock.
 */
export function parseWhwdt(payload: unknown, raw: string): CarrierResult {
  const number = normalizeWhwdtNumber(raw);
  const parcel = itdidaEntry(payload, number, PROVIDER);
  const events = itdidaScans(parcel.rows, PROVIDER, (wording) => whwdtStage(wording));
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const country = itdidaDestination(parcel, PROVIDER);
  const onward = itdidaOnward(parcel, number, PROVIDER);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    ...(onward ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
