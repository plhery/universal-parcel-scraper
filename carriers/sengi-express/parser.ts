import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { sengiExpressStage } from './status.js';

export const PROVIDER = 'Sengi Express';
export const SENGI_MAX_BYTES = 256 * 1024;

/** An SDA waybill Sengi gives a parcel for Italy before SDA knows it: the shape recognition asks about. */
export const SENGI_SDA_WAYBILL = /^\d{3}C\d{8}F$/;

/** The number as Sengi's tracker takes it: its own consignments, under SDA's waybill or a partner's code. */
export function normalizeSengiExpressNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Sengi Express needs a parcel number');
  return number;
}

const text = (value: unknown, max = 300): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
};

/** `2026-03-10T10:05:00` and Sengi's offset in hours, which its page shows as `GMT+1`, as an instant with that offset. */
function stated(clock: string, hours: unknown): string | null {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || Math.abs(hours) > 14) return null;
  const minutes = Math.round(hours * 60);
  if (minutes % 15) return null;
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${clock}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** One row of Sengi's reply: its wording, event code, place and wall clock with the offset it states. */
function scan(row: unknown, number: string): CarrierEvent {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Sengi Express returned a malformed row');
  const own = text(row.trackingNumber, 64);
  const relabel = text(row.relabelTrackingNumber, 64);
  if (own !== undefined && normalizeTrackingNumber(own) !== number && (relabel === undefined || normalizeTrackingNumber(relabel) !== number)) {
    throw new SchemaError(PROVIDER, 'Sengi Express returned another parcel');
  }
  const description = text(row.description) ?? text(row.zhDescription);
  const clock = typeof row.eventTime === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(row.eventTime) ? row.eventTime : undefined;
  if (!description || !clock) throw new SchemaError(PROVIDER, 'Sengi Express returned a row without a wording or a time');
  const code = text(row.eventCode, 16) ?? '';
  const place = text(row.location, 80);
  const time = stated(clock, row.timeZone);
  const staged = sengiExpressStage(description, code);
  return {
    ...(time ? { time } : { local_time: clock }),
    description,
    ...(place && place !== '-' ? { location: place } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    ...(code ? { provider_code: code } : {}),
  };
}

/**
 * Sengi's reply: an object keyed by each number it holds, each with its rows
 * oldest first, or an empty object. Only the requested number establishes the
 * parcel; a row naming another parcel is a schema error.
 */
export function parseSengiExpress(payload: unknown, raw: string): CarrierResult {
  const number = normalizeSengiExpressNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Sengi Express returned a malformed reply');
  const keys = Object.keys(payload);
  if (!keys.length) throw new NotFoundError(PROVIDER);
  const key = keys.find((candidate) => normalizeTrackingNumber(candidate) === number);
  if (!key || keys.length > 1) throw new SchemaError(PROVIDER, 'Sengi Express returned another parcel');
  const rows = payload[key];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Sengi Express returned malformed rows');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const events = rows.map((row) => scan(row, number)).reverse();
  const latest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const newest = rows.at(-1) as Record<string, unknown>;
  const relabel = text(newest.relabelTrackingNumber, 64);
  const onward = relabel ? normalizeTrackingNumber(relabel) : '';
  // Sengi's line to Poste Italiane ("PI"), which delivers under the same number or the code Sengi relabels it with.
  const poste = rows.every((row) => isRecord(row) && row.channelCode === 'PI');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    expected_delivery: null,
    ...(poste ? { delivery_carrier: 'poste-italiane' } : {}),
    ...(/^[A-Z0-9]{4,40}$/.test(onward) && onward !== number ? { delivery_tracking_number: onward } : {}),
    events,
  };
}
