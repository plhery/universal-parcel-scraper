import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { cargologicStage, cargologicWording } from './status.js';

export const PROVIDER = 'cargologic';
// A waybill's reply is under a kilobyte.
export const CARGOLOGIC_MAX_BYTES = 64 * 1024;
/** Cargologic handles freight at Zurich Airport only, so its clocks are Zurich's. */
export const CARGOLOGIC_ZONE = 'Europe/Zurich';
const LOCATION = 'Zurich (ZRH)';
/** Lufthansa Cargo's prefix: the tracker sends its waybills to Lufthansa Cargo's own tracker. */
const LUFTHANSA_PREFIX = '020';

const CODE = /^[A-Z]{3}$/;
const AIRPORT = /^[A-Z]{3}$/;
const TYPES = new Set(['IMPORT', 'EXPORT', 'TRANSIT']);
const POSITION = /^position(\d{1,2})List$/;
const MAX_POSITIONS = 10;
const MAX_EVENTS = 100;

/**
 * The whole air waybill as the tracker's search box formats it: "016-9117 6875". The prefix
 * names the airline; the serial ends in its check digit, the first seven digits' remainder by seven.
 */
export function normalizeCargologicWaybill(raw: string): string {
  const trimmed = typeof raw === 'string' && raw.length <= 64 ? raw.trim() : '';
  const digits = /^[\d\s-]+$/.test(trimmed) ? trimmed.replace(/[\s-]/g, '') : '';
  if (!/^\d{11}$/.test(digits) || !hasMod7CheckDigit(digits.slice(3))) {
    throw new InvalidInputError(PROVIDER, 'Enter an air waybill: the airline’s three-digit prefix, then eight digits');
  }
  if (digits.startsWith(LUFTHANSA_PREFIX)) {
    throw new InvalidInputError(PROVIDER, 'Cargologic’s tracker sends Lufthansa Cargo’s air waybills to Lufthansa Cargo');
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)} ${digits.slice(7)}`;
}

/** The waybill as the tracker's error messages print it: "016-91176875". */
const printed = (waybill: string): string => waybill.replace(' ', '');

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * Reads an error reply: `{"error": "..."}` with the HTTP status. An unknown waybill is a 404
 * naming it; a transit shipment is a 451 the page answers with "please contact the carrier".
 */
export function parseCargologicError(status: number, payload: unknown, waybill: string): never {
  const message = isRecord(payload) ? clean(payload.error, 300) : '';
  if (!message) return invalid('Cargologic returned an error without its message');
  if (status === 404) {
    const named = /^(?:Could not find AWB|No Tracing Information available for) (\d{3}-\d{8})\b/.exec(message);
    if (!named) return invalid('Cargologic returned an unknown error');
    if (named[1] !== printed(waybill)) throw new IndeterminateError(PROVIDER, 'Cargologic answered for another air waybill');
    throw new NotFoundError(PROVIDER, 'Cargologic has no record of this air waybill');
  }
  if (status === 451 && /^Type [A-Z_]+ not allowed$/.test(message)) {
    throw new IndeterminateError(PROVIDER, 'Cargologic does not show transit shipments: the airline tracks them', { reason: 'tracking_withheld' });
  }
  if (status === 400 && /format not correct/i.test(message)) throw new InvalidInputError(PROVIDER, 'Cargologic refuses this air waybill');
  return invalid('Cargologic returned an unknown error');
}

function text(value: unknown, max: number): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, max) : invalid('Cargologic returned an invalid field');
}

/** "UA135/10MAY26" names the flight and its date; the flight is kept. */
function flightOf(value: unknown): string {
  const flight = text(value, 40).split('/')[0]!.replace(/\s+/g, '');
  return /^[A-Z0-9]{2}\d{1,5}[A-Z]?$/.test(flight) ? flight : '';
}

/** "3 / 5": the pieces this step counted, of the waybill's. */
function partOf(value: unknown): string {
  const pieces = /^(\d+) \/ (\d+)$/.exec(text(value, 40));
  return pieces && Number(pieces[1]) > 0 && Number(pieces[1]) < Number(pieces[2]) ? ` (${pieces[1]} of ${pieces[2]} pieces)` : '';
}

interface Scan { at: number; index: number; event: CarrierEvent & { time: string; description: string } }

function scanOf(value: unknown, index: number): Scan | null {
  if (!isRecord(value) || typeof value.active !== 'boolean') return invalid('Cargologic returned an invalid step');
  const code = typeof value.code === 'string' ? value.code.trim().toUpperCase() : '';
  if (!CODE.test(code)) return invalid('Cargologic returned an invalid step');
  // The page lists the steps a waybill of its kind goes through and marks those that happened.
  if (!value.active) return null;
  const clock = zonedTime(`${text(value.date, 20)} ${text(value.time, 20)}`, 'ddMMMyy HH:mm', CARGOLOGIC_ZONE, { locale: 'en' });
  if (!clock) return invalid('Cargologic returned a step without a valid clock');
  const flight = flightOf(value.flightInfo);
  const stage = cargologicStage(code);
  return {
    at: clock.timestamp, index,
    event: {
      time: clock.iso,
      description: `${cargologicWording(code) ?? code}${flight ? ` on ${flight}` : ''}${partOf(value.pieces)}`,
      // A manifest announces goods still on the flight to Zurich.
      ...(code === 'FFM' ? {} : { location: LOCATION }),
      provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}),
    },
  };
}

/**
 * Reads the 200 reply of `GET /.servlet/tracking/1.0/?awb=<waybill>`: the waybill's kind,
 * stations, pieces and weight, and its steps at Zurich in up to four positions. The reply does
 * not repeat the waybill, so the request binds it. Steps carry Zurich's wall clock.
 */
export function parseCargologic(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !isRecord(payload.row)) return invalid('Cargologic returned an unreadable reply');
  const type = text(payload.type, 20);
  const origin = text(payload.originStation, 10), destination = text(payload.destination, 10);
  if (!TYPES.has(type) || (origin && !AIRPORT.test(origin)) || (destination && !AIRPORT.test(destination))) {
    return invalid('Cargologic returned an invalid waybill summary');
  }
  const positions = Object.entries(payload.row).map(([key, list]) => ({ order: Number(POSITION.exec(key)?.[1] ?? NaN), list }));
  if (positions.length > MAX_POSITIONS || positions.some(({ order, list }) => !Number.isInteger(order) || !Array.isArray(list))) {
    return invalid('Cargologic returned invalid steps');
  }
  const scans: Scan[] = [];
  for (const { list } of positions.sort((a, b) => a.order - b.order)) {
    for (const value of list as unknown[]) {
      if (scans.length >= MAX_EVENTS) return invalid('Cargologic returned too many steps');
      const scan = scanOf(value, scans.length);
      if (scan) scans.push(scan);
    }
  }
  if (scans.length === 0) throw new NoHistoryError(PROVIDER, 'Cargologic lists the air waybill without a step', { reason: 'listed' });

  // Newest first; steps dated alike keep the page's order, the later position last.
  const events = scans.sort((a, b) => b.at - a.at || b.index - a.index).map((scan) => scan.event);
  const current = events.find((event) => event.stage)?.stage as Stage | undefined;
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current ? { current_stage: current, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: events[0]!.time,
    expected_delivery: null,
    events,
  };
}
