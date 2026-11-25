import { CHECKSUMS } from '../../core/detection/checksums.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime, mislabeledWallTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { aslStage } from './status.js';

export const PROVIDER = 'asl-track';
// A shipment with its scans is a few kilobytes; the API sends at most fifty scans.
export const ASL_MAX_BYTES = 256 * 1024;

// ASL, ten digits and a Luhn check digit over them.
const NUMBER = /^ASL\d{11}$/;
const MAX_SCANS = 200;
// ASL Track's own stamps keep the fraction of a second its database writes; a carrier's are to the minute.
const OWN_STAMP = /T\d{2}:\d{2}:\d{2}\.\d+/;

/** A number for ASL Track's API: ASL and eleven digits whose last is their Luhn check, in capitals. */
export function normalizeAslNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the ASL tracking number');
  // The API answers a wrong number as it answers an unknown one, so the check digit is read here.
  if (!CHECKSUMS['luhn-digits'](number)) throw new InvalidInputError(PROVIDER, 'This ASL tracking number fails its check digit');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max = 300): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('ASL Track returned an invalid field');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
};

/**
 * A scan's time. The API labels every time UTC, but it stores the carrier's wall clock, which comes
 * without a zone, as given: the digits are the scan place's clock. A stamp with a fraction of a
 * second is ASL Track's own, a real instant.
 */
function scanTime(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const parsed = explicitOffsetTime(value);
  if (!parsed || parsed.timestamp < Date.UTC(2001, 0, 1)) return invalid('ASL Track returned an invalid scan time');
  if (OWN_STAMP.test(value as string)) return { time: parsed.iso };
  return { local_time: mislabeledWallTime(value)!.replace(/\.\d+$/, '') };
}

/** A scan's or the shipment's stage: the wording the map knows, else the status code, else the shared rules. */
function stageOf(code: string | undefined, wording: string): { stage: Stage; stage_source: string } | undefined {
  const mapped = aslStage(code ?? null, wording);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, stage_source: worded.source };
}

const statusCode = (value: unknown): string | undefined => {
  const code = text(value, 40);
  if (code && !/^[a-z_]{2,40}$/.test(code)) return invalid('ASL Track returned an invalid status code');
  return code;
};

/**
 * Reads the API's answer for one number, its scans newest first as the API sends them. The origin
 * and destination towns, and the delivery time the delivered scan already gives, stay behind.
 */
export function parseAsl(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) return invalid('ASL Track returned an unreadable reply');
  if (payload.found === false) throw new NotFoundError(PROVIDER, 'ASL Track has no shipment under this number');
  if (payload.found !== true || (payload.events !== undefined && payload.events !== null && !Array.isArray(payload.events))) {
    return invalid('ASL Track returned an invalid shipment');
  }
  const asked = typeof payload.tracking_number === 'string' ? normalizeTrackingNumber(payload.tracking_number).toUpperCase() : '';
  if (asked !== number) throw new IndeterminateError(PROVIDER, 'ASL Track answered for another number');
  const scans = (payload.events ?? []) as unknown[];
  if (scans.length > MAX_SCANS) return invalid('ASL Track returned too many scans');

  const events = scans.map((scan): CarrierEvent => {
    if (!isRecord(scan)) return invalid('ASL Track returned an invalid scan');
    const description = text(scan.description) ?? invalid('ASL Track returned a scan without its wording');
    const code = statusCode(scan.status);
    const location = text(scan.location, 120);
    return { ...scanTime(scan.occurred_at), description, ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...stageOf(code, description) };
  });

  const code = statusCode(payload.status);
  const current = code ? stageOf(code, '') : undefined;
  if (!current && events.length === 0) return invalid('ASL Track returned a shipment without a status or scans');
  const newest = events.find((event) => event.stage);
  const stage = current?.stage ?? newest?.stage as Stage | undefined;
  const destination = countryCode(payload.destination_country);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current ? current.stage_source : newest!.stage_source! } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: events[0]?.description ?? null,
    last_update: events[0]?.time ?? null,
    ...(events[0]?.local_time ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...unreadEstimates({ estimated_delivery: payload.estimated_delivery }),
    ...(destination ? { destination_country: destination } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
