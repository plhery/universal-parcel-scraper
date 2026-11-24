import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { recibeloStage } from './status.js';

export const PROVIDER = 'recibelo';
/** The lookup Recíbelo's tracking page asks, with the number as `internal_ids[]`. */
export const RECIBELO_LOOKUP = 'https://app.recibelo.cl/api/check-package-internal-id';
// A parcel's reply is under 1 KB.
export const RECIBELO_MAX_BYTES = 256 * 1024;
/** The tracker's answer, with HTTP 404, when it holds no parcel under the number. */
export const RECIBELO_NOT_FOUND = 'Paquetes no encontrados';

// Recíbelo's shipment numbers: letters, digits and hyphens, with a digit.
const NUMBER = /^(?=[^\d]*\d)[A-Z0-9-]{5,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// "2024-06-21 18:36:31": the wall clock in Chile, without a zone.
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// Statuses the tracking page hides a parcel under, so that another parcel of the same number shows.
const HIDDEN = new Set(['no aceptado', 'sin comuna', 'falta información']);
const MAX_PARCELS = 20;
const MAX_EVENTS = 200;

/** A number for Recíbelo's tracker, without spaces, in capitals. */
export function normalizeRecibeloNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Recíbelo tracks numbers of 5 to 40 letters, digits and hyphens');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isRecibeloBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wording(value: unknown, what: string): string {
  const text = typeof value === 'string' ? clean(value, 80) : '';
  return text || invalid(`Recíbelo returned a ${what} without its status`);
}

function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? WALL_CLOCK.exec(value.trim()) : null;
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2000) return invalid('Recíbelo returned an invalid status time');
  return `${day}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
}

function eventOf(row: unknown): CarrierEvent {
  if (!isRecord(row)) return invalid('Recíbelo returned an invalid status');
  const description = wording(row.status, 'history entry');
  const stage = recibeloStage(description);
  return { local_time: wallClock(row.created_at), description, ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

/** The parcel the tracking page would show: the only one, or the only one it does not hide. */
function parcelOf(rows: readonly unknown[], number: string): Record<string, unknown> {
  if (rows.length > MAX_PARCELS) return invalid('Recíbelo returned too many parcels');
  const parcels = rows.map((row) => (isRecord(row) ? row : invalid('Recíbelo returned an invalid parcel')));
  // Every parcel must carry the number asked.
  for (const parcel of parcels) {
    if (typeof parcel.internal_id !== 'string' && typeof parcel.internal_id !== 'number') return invalid('Recíbelo returned a parcel without its number');
    if (String(parcel.internal_id).replace(/\s+/g, '').toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Recíbelo answered for another parcel');
  }
  const shown = parcels.length === 1 ? parcels
    : parcels.filter((parcel) => !HIDDEN.has(wording(parcel.current_status, 'parcel').toLowerCase()));
  // Parcels for several recipients share the number: the page asks which one is the visitor's.
  if (shown.length !== 1) throw new IndeterminateError(PROVIDER, 'Recíbelo lists several parcels under this number');
  return shown[0]!;
}

/**
 * The reply of `GET app.recibelo.cl/api/check-package-internal-id`, the lookup Recíbelo's
 * tracking page makes: a list of parcels under the number, each with its current status and its
 * statuses, newest first, on Chile's wall clock. The recipient's name is never read.
 */
export function parseRecibelo(payload: unknown, raw: string): CarrierResult {
  const number = normalizeRecibeloNumber(raw);
  if (!Array.isArray(payload)) return invalid('Recíbelo returned an unexpected reply');
  if (payload.length === 0) throw new IndeterminateError(PROVIDER, 'Recíbelo returned no parcel');
  const parcel = parcelOf(payload, number);
  if (!Array.isArray(parcel.history_statuses)) return invalid('Recíbelo returned a parcel without its statuses');
  if (parcel.history_statuses.length > MAX_EVENTS) return invalid('Recíbelo returned too many statuses');
  const events = parcel.history_statuses.map(eventOf);
  const current = wording(parcel.current_status, 'parcel');
  const stage = recibeloStage(current);
  const newest = events[0];
  if (!newest) {
    if (!stage) throw new NoHistoryError(PROVIDER, 'Recíbelo lists the parcel without its statuses', { reason: 'listed' });
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
      last_status_text: current, last_update: null, expected_delivery: null, summary_only: true, events: [],
    };
  }
  // The parcel's current status leads; it is the newest entry of its statuses.
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' as const } : {}),
    last_status_text: current,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function recibeloJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isRecibeloBlocked(body)) throw new ChallengeError(PROVIDER, 'Recíbelo answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Recíbelo returned a reply that is not JSON', { cause });
  }
}
