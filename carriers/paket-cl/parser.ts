import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { PAKET_LOST, paketAlert, paketMappedStage, paketStage, paketStep, statusMap } from './status.js';

export const PROVIDER = 'Paket';
export const CARRIER = 'paket-cl';
// A parcel with four rows is about 1.3 kB.
export const PAKET_MAX_BYTES = 128 * 1024;
// The Santiago Metropolitan, Valparaíso and O'Higgins regions, where Paket delivers, keep one clock.
export const PAKET_ZONE = 'America/Santiago';

// The tracking page takes four to twelve digits.
const NUMBER = /^\d{4,12}$/;
// "2026-05-15 15:41:58": a wall clock with no zone, to the second.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?$/;
// The tracker's answer, with HTTP 404, for a number it holds nothing for.
const NOT_FOUND = 'Envío no encontrado';
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
const MAX_ROWS = 200;

/** A number for Paket's tracker: four to twelve digits. */
export function normalizePaketNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Paket looks parcels up by 4 to 12 digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isPaketBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field, which the reply writes as a string or null. */
function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) return invalid('Paket returned an invalid field');
  return clean(value, max);
}

/** An object field, which the reply may leave out. */
function block(value: unknown, name: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  return isRecord(value) ? value : invalid(`Paket returned an invalid ${name}`);
}

/** A whole number the reply writes as a JSON integer or in digits, without leading zeros; empty when absent. */
function whole(value: unknown, digits: number): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && String(value).length <= digits) return String(value);
  if (typeof value === 'string' && new RegExp(`^\\d{1,${digits}}$`).test(value)) return value.replace(/^0+(?=\d)/, '');
  return invalid('Paket returned an invalid number');
}

/**
 * A row's clock, calendar-checked. The reply names no zone; the three regions Paket delivers
 * in keep Santiago's clock, so the wall clock gets an instant there and says so.
 */
function clock(value: unknown): { time: string; local_time: string; time_zone: string; time_zone_basis: string } {
  const parts = CLOCK.exec(text(value, 40));
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) {
    return invalid('Paket returned an invalid scan time');
  }
  const local = `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
  const instant = isoTime(local, PAKET_ZONE) ?? invalid('Paket returned an invalid scan time');
  return { time: instant.iso, local_time: local, time_zone: PAKET_ZONE, time_zone_basis: 'carrier' };
}

/** One history row: its state code, its state's sentence, else its title, and its clock. */
function row(value: unknown): CarrierEvent & { local_time: string } {
  if (!isRecord(value)) return invalid('Paket returned an invalid history row');
  const code = whole(value.estado, 4);
  const description = text(value.descripcion, 300) || text(value.titulo, 120) || invalid('Paket returned a history row without its wording');
  const staged = paketStage(code, description);
  return {
    ...clock(value.fecha),
    description,
    ...(code ? { provider_code: code } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Newest first, as the tracker lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(events: (CarrierEvent & { local_time: string })[]): CarrierEvent[] {
  const ordered = events.length > 1 && events[0]!.local_time < events.at(-1)!.local_time ? events.reverse() : events;
  return ordered.sort((a, b) => b.local_time.localeCompare(a.local_time));
}

/** The progress rail's step as a whole number, or nothing; the rail has steps 0 to 4. */
function railStep(value: unknown): number | undefined {
  const step = typeof value === 'number' ? value : typeof value === 'string' && /^\d$/.test(value) ? Number(value) : undefined;
  return step !== undefined && Number.isInteger(step) ? step : undefined;
}

/**
 * The reply of `envios/tracking.php` for one number, the lookup Paket's tracking page makes.
 * It gives the shipment with its number and state code, the state's title and sentence, the
 * page's progress rail with an alert, whether Paket marks the parcel as lost, and the history
 * rows, each with a state code, a title, a sentence and a wall clock to the second.
 *
 * The recipient's masked name, address and phone, the commune, the delivery note, the map
 * point, the photos and the shop's name are never read.
 */
export function parsePaket(payload: unknown, raw: string): CarrierResult {
  const number = normalizePaketNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') return invalid('Paket returned an unexpected reply');
  // The page reads anything but a success as a lookup it could not make; a missing parcel is a 404.
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Paket did not complete the lookup');
  const data = isRecord(payload.data) ? payload.data : invalid('Paket returned a reply without its shipment');
  const shipment = isRecord(data.envio) ? data.envio : invalid('Paket returned a reply without its shipment');
  // The tracker reads the number as a whole number: it repeats it as one, without leading zeros.
  const id = whole(shipment.id, 12) || invalid('Paket returned a shipment without its number');
  if (id !== number.replace(/^0+(?=\d)/, '')) throw new IndeterminateError(PROVIDER, 'Paket answered for another number');

  if (data.historial !== undefined && data.historial !== null && !Array.isArray(data.historial)) {
    return invalid('Paket returned an invalid history');
  }
  const rows = (data.historial ?? []) as unknown[];
  if (rows.length > MAX_ROWS) return invalid('Paket returned too many history rows');
  const events = newestFirst(rows.map(row));

  const progress = block(data.progreso, 'progress');
  const alert = paketAlert(text(progress.alerta, 40));
  // A parcel Paket looks for, or one with an alert of a stage, takes the page's headline.
  const headline = block(data.extraviado, 'lost flag').es_extraviado === true ? PAKET_LOST : alert?.stage ? alert : undefined;
  const step = paketStep(railStep(progress.paso) ?? -1);
  const newest = events[0];
  if (!newest) {
    // A shipment without rows stands on its own state code, else the rail's step.
    const code = whole(shipment.estado, 4);
    const stage: Stage | undefined = headline?.stage ?? paketMappedStage(code) ?? step?.stage;
    if (!stage) throw new NoHistoryError(PROVIDER, 'Paket lists the shipment without history', { reason: 'listed' });
    const state = block(data.estado_info, 'state');
    return {
      status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
      ...(code ? { provider_code: code } : {}),
      last_status_text: headline?.label ?? (text(state.descripcion, 300) || text(state.titulo, 120) || step?.label || null),
      last_update: null, expected_delivery: null, summary_only: true, events: [],
    };
  }
  // The newest staged row leads, under the headline; the rail's step stands in when no row leads,
  // as when a newer row without a stage may have undone a delivery.
  const lead = leadingScan(events, statusMap);
  const stage = (headline?.stage ?? lead?.stage ?? step?.stage) as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: headline || !lead?.stage ? 'carrier_map' : lead.stage_source } : {}),
    last_status_text: headline?.label ?? newest.description!,
    last_update: newest.time!,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}

/** Whether a reply is the tracker's answer for a number it holds nothing for. */
export function isPaketNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.success === false && text(payload.error, 200) === NOT_FOUND
    && (payload.data === undefined || payload.data === null);
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function paketJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isPaketBlocked(body)) throw new ChallengeError(PROVIDER, 'Paket answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Paket returned a reply that is not JSON', { cause });
  }
}
