import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { commerciveStage } from './status.js';

export const PROVIDER = 'commercive-parcel';
// A parcel with its scans is a few kilobytes.
export const COMMERCIVE_MAX_BYTES = 256 * 1024;

// CMV and its digits, the last of which is a Luhn check; the tracker checks it, not the adapter.
const NUMBER = /^CMV\d{12,30}$/;
const MAX_SCANS = 300;

/** A number for Commercive Parcel's tracker: CMV and its digits, in capitals as the page sends it. */
export function normalizeCommerciveNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the CMV tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max = 300): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('Commercive Parcel returned an invalid field');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
};
const instant = (value: unknown, what: string) => {
  const parsed = explicitOffsetTime(value);
  if (!parsed || parsed.timestamp < Date.UTC(2001, 0, 1)) return invalid(`Commercive Parcel returned an invalid ${what}`);
  return parsed;
};

/** A scan's or the parcel's stage: the wording the map knows, else the parcel's code, else the shared rules. */
function stageOf(code: string | undefined, wording: string): { stage: Stage; stage_source: string } | undefined {
  const mapped = commerciveStage(code ?? null, wording);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, stage_source: worded.source };
}

/**
 * Reads the tracker's answer for one number. Its times are instants in UTC. The recipient's town,
 * the delivery photos and the origin stay behind.
 */
export function parseCommercive(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return invalid('Commercive Parcel returned an unreadable reply');
  const answers = payload.results.filter((answer) => isRecord(answer)
    && typeof answer.number === 'string' && normalizeTrackingNumber(answer.number).toUpperCase() === number);
  if (answers.length !== 1) {
    if (payload.results.length === 1) throw new IndeterminateError(PROVIDER, 'Commercive Parcel answered for another number');
    return invalid('Commercive Parcel did not answer once for the number asked');
  }
  const answer = answers[0] as Record<string, unknown>;
  if (answer.found === false) {
    if (answer.reason === 'not_found') throw new NotFoundError(PROVIDER, 'Commercive Parcel has no parcel under this number');
    if (answer.reason === 'invalid') throw new InvalidInputError(PROVIDER, 'Commercive Parcel says this is not one of its tracking numbers');
    return invalid('Commercive Parcel returned an unknown reason for a missing parcel');
  }
  if (answer.found !== true || (answer.events !== undefined && !Array.isArray(answer.events))) return invalid('Commercive Parcel returned an invalid parcel');
  const scans = (answer.events ?? []) as unknown[];
  if (scans.length > MAX_SCANS) return invalid('Commercive Parcel returned too many scans');

  const events = scans.map((scan, index): { index: number; timestamp: number; event: CarrierEvent } => {
    if (!isRecord(scan)) return invalid('Commercive Parcel returned an invalid scan');
    const description = text(scan.description) ?? invalid('Commercive Parcel returned a scan without its wording');
    const time = instant(scan.time, 'scan time');
    const location = text(scan.location, 120);
    return { index, timestamp: time.timestamp, event: { time: time.iso, description, ...(location ? { location } : {}), ...stageOf(undefined, description) } };
  }).sort((a, b) => b.timestamp - a.timestamp || a.index - b.index).map(({ event }) => event);

  const code = text(answer.status, 40);
  if (code && !/^[a-z_]{2,40}$/.test(code)) return invalid('Commercive Parcel returned an invalid status code');
  const label = text(answer.statusLabel, 120);
  const current = code ? stageOf(code, label ?? '') : undefined;
  if (!current && events.length === 0) return invalid('Commercive Parcel returned a parcel without a status or scans');
  const stage = current?.stage ?? events.find((event) => event.stage)?.stage as Stage | undefined;
  const delivered = stage === 'delivered' && answer.deliveredAt !== null && answer.deliveredAt !== undefined
    ? instant(answer.deliveredAt, 'delivery time').iso : undefined;
  const service = isRecord(answer.service) ? text(answer.service.name, 120) : undefined;
  const destination = countryCode(answer.destinationCountry);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current ? current.stage_source : events.find((event) => event.stage)!.stage_source! } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: (current ? label : undefined) ?? events[0]?.description ?? label ?? null,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...unreadEstimates({ 'results.estimatedDelivery': answer.estimatedDelivery }),
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
