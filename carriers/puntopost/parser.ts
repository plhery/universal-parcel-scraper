import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { isReturnFail, puntopostStage, puntopostWording } from './status.js';

export const PROVIDER = 'PuntoPost';
// The service behind the tracker at www.puntopost.mx/tracking-summary/.
export const PUNTOPOST_API = 'https://back.puntopost.mx/api/web/v1/parcels/';
// A delivered parcel's reply is under 8 kB; each movement repeats both places.
export const PUNTOPOST_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;
// The tracker's own codes (MXT…) and the shops' labels (MXL…) both start MX; the service takes either.
const NUMBER = /^MX[A-Z0-9]{8,22}$/;
// Statuses at which the page shows the destination point, and at which it shows the origin.
const AT_DESTINATION: ReadonlySet<string> = new Set(['in_transit_destination', 'in_destination_point', 'in_rerouted_point', 'delivered']);
const AT_ORIGIN: ReadonlySet<string> = new Set(['return_in_transit_origin', 'return_in_origin_point', 'return_in_rerouted_point', 'return_delivered']);
// The movement that carries the place of each status: the departure from a place, the way to the next, the arrival.
const MOVEMENT_OF: Readonly<Record<string, string>> = {
  in_origin_point: 'in_origin', in_transit_depot: 'in_transit', in_depot: 'in_destination',
  in_transit_destination: 'in_transit', in_destination_point: 'in_destination', in_rerouted_point: 'in_destination',
  in_transit_origin: 'in_transit', in_origin_point_return: 'in_destination',
};
// A status and its movement are written within seconds of each other.
const PAIRING_MS = 120_000;

/** A PuntoPost code or a shop's label: MX, then letters and digits. The service is case-sensitive and issues them in capitals. */
export function normalizePuntopostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'PuntoPost numbers are MX followed by letters and digits');
  return number;
}

export const puntopostUrl = (raw: string): string => `${PUNTOPOST_API}${encodeURIComponent(normalizePuntopostNumber(raw))}`;

/** The service's problem reply for a parcel it does not have. */
export function isPuntopostAbsence(body: unknown): boolean {
  return isRecord(body) && body.type === 'NOT_FOUND' && body.instance === 'parcel';
}

function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `PuntoPost returned an invalid ${key}`);
  return clean(value, maxLength);
}

function instant(value: unknown): { time: string; timestamp: number } {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ? DateTime.fromISO(value, { setZone: true }) : null;
  if (!parsed?.isValid || parsed.year < 2000) throw new SchemaError(PROVIDER, 'PuntoPost returned an invalid clock');
  const second = parsed.set({ millisecond: 0 });
  return { time: second.toISO({ suppressMilliseconds: true }), timestamp: second.toMillis() };
}

interface Place { id: string; type: string; name: string; city: string; address: string }

function place(value: unknown): Place | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'PuntoPost returned an invalid place');
  const address = value.address === null || value.address === undefined ? {} : value.address;
  if (!isRecord(address)) throw new SchemaError(PROVIDER, 'PuntoPost returned an invalid address');
  return { id: text(value, 'id', 80), type: text(value, 'type', 40), name: text(value, 'name'),
    city: text(address, 'city'), address: text(address, 'address', 300) };
}

function list(value: unknown, name: string): unknown[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new SchemaError(PROVIDER, `PuntoPost returned an invalid ${name}`);
  return value;
}

interface Movement { status: string; origin: Place | null; destination: Place | null; timestamp: number; used: boolean }

/** A place as the page names it: points as `PuntoPost …`, with their role on the way out; depots and shops by name. */
function placeName(where: Place | null, globals: { origin?: string; destination?: string }, isReturn: boolean): string {
  if (!where) return '';
  if (where.type !== 'pudo') return where.name;
  if (!isReturn && where.id && where.id === globals.origin) return `PuntoPost origen ${where.name}`;
  if (!isReturn && where.id && where.id === globals.destination) return `PuntoPost destino ${where.name}`;
  return `PuntoPost ${where.name}`;
}

const capitalized = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** The page's line for a movement, such as `En camino a Almacén CDMX`. */
function movementText(movement: Movement, globals: { origin?: string; destination?: string }, isReturn: boolean): { text: string; where: Place | null } {
  const prefix = isReturn ? 'Devolución ' : '';
  if (movement.status === 'in_origin') {
    const name = placeName(movement.origin, globals, isReturn);
    return { text: capitalized(`${prefix}en ${name || 'origen'}`), where: movement.origin };
  }
  const name = placeName(movement.destination, globals, isReturn);
  // On the way, the scan happened where the parcel left.
  if (movement.status === 'in_transit') return { text: capitalized(`${prefix}en camino${name ? ` a ${name}` : ''}`), where: movement.origin };
  return { text: capitalized(`${prefix}en ${name || 'destino'}`), where: movement.destination };
}

/** The point to collect from, as the page shows it: its name, then its address. */
function pickupPoint(where: Place | null): string | null {
  return where?.type === 'pudo' && where.name ? [where.name, where.address].filter(Boolean).join('\n') : null;
}

/** Read the reply `GET /parcels/{number}` gives for one parcel, bound to the number asked. */
export function parsePuntopost(body: unknown, raw: string): CarrierResult {
  const number = normalizePuntopostNumber(raw);
  if (isPuntopostAbsence(body)) throw new NotFoundError(PROVIDER);
  const detail = isRecord(body) ? body.detail : undefined;
  if (!isRecord(detail)) throw new SchemaError(PROVIDER, 'PuntoPost returned a reply without its parcel');
  const tracking = text(detail, 'tracking', 64), label = text(detail, 'label', 64);
  // The service finds a parcel by either identifier; the reply must name the one asked.
  if (tracking !== number && label !== number) throw new SchemaError(PROVIDER, 'PuntoPost did not identify the requested parcel');
  const status = text(detail, 'status', 80);
  if (!status) throw new SchemaError(PROVIDER, 'PuntoPost returned a parcel without its status');
  const origin = place(detail.origin), destination = place(detail.destination);
  const globals = { origin: origin?.id || undefined, destination: destination?.id || undefined };

  const history = list(detail.status_history, 'history').map((row, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PuntoPost returned an invalid history row');
    const code = text(row, 'status', 80);
    if (!code) throw new SchemaError(PROVIDER, 'PuntoPost returned an unnamed history row');
    return { code, ...instant(row.when), index };
  });
  const movements: Movement[] = list(detail.movements, 'movements').map(row => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PuntoPost returned an invalid movement');
    return { status: text(row, 'status', 80), origin: place(row.origin), destination: place(row.destination),
      timestamp: instant(row.created_at).timestamp, used: false };
  });

  // Once a return has failed, the page shows nothing after the parcel came back to its origin point.
  const failed = history.find(row => row.code === 'return_fail_in_origin_point');
  const shown = failed ? history.filter(row => row.timestamp <= failed.timestamp) : history;

  const scans = shown.map(row => {
    const isReturn = row.code.startsWith('return_');
    const key = row.code === 'return_in_origin_point' ? 'in_origin_point_return' : row.code.replace(/^return_/, '');
    const wanted = MOVEMENT_OF[key];
    // The movement written with this status names the place; the page shows its line instead of the status.
    const movement = wanted ? movements
      .filter(item => !item.used && item.status === wanted && Math.abs(item.timestamp - row.timestamp) <= PAIRING_MS)
      .sort((left, right) => Math.abs(left.timestamp - row.timestamp) - Math.abs(right.timestamp - row.timestamp))[0] : undefined;
    let description = puntopostWording(row.code), where: Place | null = null;
    if (movement) {
      movement.used = true;
      ({ text: description, where } = movementText(movement, globals, isReturn));
    } else if (row.code === 'delivered') where = destination;
    else if (row.code === 'return_delivered') where = origin;
    const stage = puntopostStage(row.code);
    const event: CarrierEvent = { time: row.time, description, provider_code: row.code,
      ...(where?.city ? { location: where.city } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { event, timestamp: row.timestamp, index: row.index };
  });
  // Newest first; the service's order settles rows of one second.
  scans.sort((left, right) => right.timestamp - left.timestamp || right.index - left.index);
  const events = scans.map(scan => scan.event);

  // The parcel's own status decides its stage, as on the page's badge.
  const stage = puntopostStage(status);
  const newest = events[0];
  const current = events.find(event => event.provider_code === status) ?? newest;
  const delivered = status === 'delivered' ? events.find(event => event.provider_code === 'delivered')?.time ?? null : null;
  const point = AT_DESTINATION.has(status) ? pickupPoint(destination) : AT_ORIGIN.has(status) ? pickupPoint(origin) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: status,
    last_status_text: isReturnFail(status) ? puntopostWording(status) : current?.description ?? puntopostWording(status),
    last_update: newest?.time ?? null,
    expected_delivery: null,
    ...(origin?.type === 'merchant' && origin.name ? { sender_name: origin.name } : {}),
    ...(point ? { pickup_point: point } : {}),
    ...(status === 'delivered' ? { delivered_at: delivered } : {}),
    ...(tracking && tracking !== number ? { canonical_tracking_number: tracking } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
