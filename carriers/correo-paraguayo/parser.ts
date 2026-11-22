import { DateTime } from 'luxon';
import { isValidS10TrackingNumber, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { correoParaguayoStage } from './status.js';

export const PROVIDER = 'Correo Paraguayo';
// A reply is one row of about 300 bytes a record.
export const CORREO_PARAGUAYO_MAX_BYTES = 64 * 1024;
/** The JSON endpoint the tracker page asks for one item. */
export const CORREO_PARAGUAYO_API = 'https://apps.correoparaguayo.gov.py:444/sen/';

// Paraguay keeps UTC-3 all year.
const ZONE = 'America/Asuncion';
const MAX_ROWS = 50;
// "2025-01-09 12:48:47.656": the server's wall clock, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/;
const NOT_FOUND = /^No existen datos para el c[oó]digo\.\s*([A-Z0-9]{1,40})$/i;
// A firewall's, CDN's or bot check's page in place of the endpoint's JSON.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Attention Required|Just a moment|Web Page Blocked|Bot Verification)|requested URL was rejected|_cf_chl_opt|cf-turnstile|g-recaptcha/i;

/**
 * The tracker reads UPU S10 item codes: Correo Paraguayo's own, ending PY,
 * and those of the posts that send mail to Paraguay. The code needs a valid
 * check digit. The layout of its domestic numbers is not public.
 */
export function normalizeCorreoParaguayoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (isValidS10TrackingNumber(number)) return number;
  throw new InvalidInputError(PROVIDER, 'Correo Paraguayo tracks S10 item codes');
}

/** The endpoint's address for one item, as the tracker page builds it. */
export function correoParaguayoUrl(number: string): string {
  return `${CORREO_PARAGUAYO_API}?${new URLSearchParams({ id_envio: number })}`;
}

/** A clock of the reply as an instant in Paraguay, or nothing when the field is empty. */
function instantOf(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  const wall = match ? `${match[1]}T${match[2]}` : '';
  const zoned = match ? firstOccurrence(DateTime.fromISO(wall, { zone: ZONE })) : null;
  if (!zoned?.isValid || zoned.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, `Correo Paraguayo returned an invalid ${field}`);
  }
  return zoned.toISO({ suppressMilliseconds: true });
}

function text(row: Record<string, unknown>, field: string, length: number): string {
  const value = row[field];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Correo Paraguayo returned an invalid ${field}`);
  return clean(value, length);
}

interface Row { events: CarrierEvent[]; status: string; updated: string | null; kilograms: number | null }

function stepOf(time: string, description: string, location: string): CarrierEvent {
  const stage = correoParaguayoStage(description.split(': ')[0]!);
  return { time, ...(location ? { location } : {}), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/**
 * One record of the item: when it entered the network, when it went on a
 * dispatch sheet to the office in charge of it, and its status now. The
 * addressee's name and the sheet's number are not read.
 */
function rowOf(value: unknown, number: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(PROVIDER, 'Correo Paraguayo returned an invalid record');
  const row = value as Record<string, unknown>;
  if (text(row, 'cod_envio', 40).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Correo Paraguayo answered for a different item');
  const status = text(row, 'estado', 80);
  if (!status) throw new SchemaError(PROVIDER, 'Correo Paraguayo returned a record without a status');
  const office = text(row, 'dependencia', 80);
  const entered = instantOf(row.ingreso, 'entry time');
  const listed = instantOf(row.fechaplanillado, 'dispatch time');
  const updated = instantOf(row.actualizacion, 'update time');
  const destination = text(row, 'responsable', 80);
  const events = [
    ...(entered ? [stepOf(entered, 'Ingreso', '')] : []),
    ...(listed ? [stepOf(listed, destination ? `Planillado: ${destination}` : 'Planillado', office)] : []),
  ];
  // A status other than the dispatch sheet is dated by the record's update,
  // when that comes after both steps.
  if (updated && !/^planillado$/i.test(status) && events.every((event) => Date.parse(event.time!) < Date.parse(updated))) events.push(stepOf(updated, status, office));
  const weight = Number(text(row, 'peso', 16));
  return { events, status, updated, kilograms: Number.isFinite(weight) && weight > 0 ? Math.round(weight * 1000) / 1000 : null };
}

/**
 * The endpoint's JSON for one item: its records, or a message when it holds
 * nothing for the code, which is not found. It answers an item from abroad
 * once Correo Paraguayo has it; the origin post's scans are not there.
 */
export function parseCorreoParaguayo(body: string, rawNumber: string): CarrierResult {
  const number = normalizeCorreoParaguayoNumber(rawNumber);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (BLOCKED.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Correo Paraguayo answered with a block page');
    throw new SchemaError(PROVIDER, 'Correo Paraguayo returned an invalid reply');
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const message = text(payload as Record<string, unknown>, 'mensaje', 120);
    if (NOT_FOUND.exec(message)?.[1]?.toUpperCase() === number) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Correo Paraguayo returned an unexpected message');
  }
  if (!Array.isArray(payload) || !payload.length) throw new SchemaError(PROVIDER, 'Correo Paraguayo returned no record');
  if (payload.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Correo Paraguayo returned too many records');
  const rows = payload.map((value) => rowOf(value, number));
  const seen = new Set<string>();
  const events = rows.flatMap((row) => row.events).filter((event) => {
    const identity = JSON.stringify(event);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).sort((left, right) => Date.parse(right.time!) - Date.parse(left.time!));
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The record updated last holds the item's status now.
  const at = (time: string | null) => (time ? Date.parse(time) : -Infinity);
  const current = rows.reduce((latest, row) => (at(row.updated) > at(latest.updated) ? row : latest));
  const named = correoParaguayoStage(current.status);
  const stepped = events.find((event) => event.stage)?.stage as Stage | undefined;
  const stage = named ?? stepped;
  const kilograms = rows.map((row) => row.kilograms).find((weight) => weight !== null);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.status,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(kilograms ? { weight_kg: kilograms } : {}),
    events,
  };
}
