import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { gintracomStage, gintracomStateStage } from './status.js';

export const PROVIDER = 'gintracom';
// A guide with seven rows is under one kilobyte once the helper has dropped the shop's fields.
export const MAX_BYTES = 128_000;
/** The tracker serves mainland Ecuador and prints its clock without a zone. */
export const GINTRACOM_ZONE = 'America/Guayaquil';
const NUMBER = /^[A-Z0-9]{6,20}$/;
const MAX_ROWS = 300;
// "13 feb · 11:28": a day, a Spanish month and a minute, without a year. A year, if the tracker
// ever prints one, is read.
const CLOCK = /^(\d{1,2}) ([a-z]{3,4})\.?(?: (?:de )?(\d{4}))? · (\d{2}):(\d{2})$/;
const MONTHS: ReadonlyMap<string, number> = new Map([['ene', 1], ['feb', 2], ['mar', 3], ['abr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['ago', 8], ['sep', 9], ['sept', 9], ['set', 9], ['oct', 10], ['nov', 11], ['dic', 12]]);
// A leap day needs up to four years back.
const YEARS_BACK = 4;

/** A guide number as the tracker takes it: letters and digits, as its form sends them. */
export function normalizeGintracomNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Gintracom guide number: 6 to 20 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * A row's instant. The tracker prints a day and a month without a year: the year is the latest
 * that puts the day no later than the day after the lookup in Ecuador, as for a parcel on its way.
 */
function rowTime(text: string, now: number): string {
  const match = CLOCK.exec(text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim());
  const month = match ? MONTHS.get(match[2]!) : undefined;
  if (!match || !month || Number(match[4]) > 23 || Number(match[5]) > 59) return invalid('Gintracom returned an unreadable row time');
  const day = Number(match[1]), clock = `${match[4]}:${match[5]}:00`;
  const latest = DateTime.fromMillis(now, { zone: GINTRACOM_ZONE }).plus({ days: 1 });
  const years = match[3] ? [Number(match[3])] : Array.from({ length: YEARS_BACK + 1 }, (_, back) => latest.year - back);
  for (const year of years) {
    const date = calendarDay(year, month, day);
    if (!date || (!match[3] && date > latest.toISODate()!)) continue;
    const time = isoTime(`${date}T${clock}`, GINTRACOM_ZONE);
    if (time && year > 2000 && year <= 2100) return time.iso;
  }
  return invalid('Gintracom returned an unreadable row time');
}

type Row = CarrierEvent & { time: string; description: string };

function row(value: unknown, now: number): Row {
  if (!isRecord(value)) return invalid('Gintracom returned an unreadable row');
  const description = clean(value.texto, 160);
  const type = clean(value.tipo, 40) || null;
  if (!description || typeof value.fecha !== 'string') return invalid('Gintracom returned an unreadable row');
  const stage = gintracomStage(type, description);
  return { time: rowTime(value.fecha, now), time_zone: GINTRACOM_ZONE, time_zone_basis: 'carrier', description,
    ...(type ? { provider_code: type } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/** Reads the tracker's reply for a guide, as the browser service's helper passes it on. */
export function parseGintracom(body: unknown, number: string, now = Date.now()): CarrierResult {
  if (!isRecord(body)) return invalid('Gintracom returned an invalid reply');
  const guide = clean(body.guia, 40).toUpperCase();
  if (!guide) return invalid('Gintracom returned a reply without its guide');
  if (guide !== number) throw new IndeterminateError(PROVIDER, 'Gintracom answered for another guide');
  const state = isRecord(body.estado) ? body.estado : invalid('Gintracom returned a guide without its state');
  const title = clean(state.titulo, 160);
  if (!title) return invalid('Gintracom returned a guide without its state');
  if (!Array.isArray(body.historial)) return invalid('Gintracom returned a guide without its rows');
  if (body.historial.length > MAX_ROWS) return invalid('Gintracom returned too many rows');
  const step = body.etapa === null || body.etapa === undefined ? null
    : Number.isInteger(body.etapa) && (body.etapa as number) >= 0 && (body.etapa as number) <= 3 ? body.etapa as number
      : invalid('Gintracom returned an unreadable progress step');

  // The tracker lists the rows newest first.
  const seen = new Set<string>();
  const events = body.historial.map((value) => row(value, now)).map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.time, event.description, event.provider_code ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.time.localeCompare(a.event.time) || a.index - b.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Gintracom lists the guide without rows', { reason: 'listed' });

  // The guide's own state decides; the newest staged row, then the progress rail, a state the map does not know.
  const stage: Stage | undefined = gintracomStateStage(clean(state.codigo, 40) || null, null)
    ?? events.find((event) => event.stage)?.stage as Stage | undefined ?? gintracomStateStage(null, step);
  const delivered = stage === 'delivered' ? events.find((event) => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: title,
    last_update: newest.time,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(isRecord(body.fecha_clave) ? { unread_estimates: ['fecha_clave'] } : {}),
    destination_country: 'EC',
    timezone: GINTRACOM_ZONE,
    events,
  };
}
