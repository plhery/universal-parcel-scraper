import { DateTime } from 'luxon';
import { carrierTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { locatePlace } from '../../places/index.js';
import { ZMC_MAX_LENGTH, ZMC_MIN_LENGTH, ZMC_REFERENCE } from './number.js';
import { statusMap, zmcStage, zmcWording } from './status.js';

export const PROVIDER = 'zmc-express';
// A delivered shipment's reply is about half a kilobyte a row.
export const ZMC_MAX_BYTES = 256 * 1024;
// The tracker's whole answer for a reference it holds no shipment under, with HTTP 200.
const NOT_FOUND = 'error';
const MAX_ROWS = 300;
const CLOCK = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CODE = /^\d{1,4}$/;
// ZMC Express's own clock, its home in Iraq, and its Chinese warehouses' clock.
const HOME_ZONE = 'Asia/Baghdad';
const CHINA_ZONE = 'Asia/Shanghai';
// The codes whose detail is the warehouse that received the parcel: "Received by cargo warehouse
// => GUANGZHOU-AIR", "Received in Iraq COD warehouse | Erbil Store".
const WAREHOUSE_CODES: ReadonlySet<string> = new Set(['200', '400']);
const IRAQ = /\biraq\b/i;
// A run of eight or more digits in a detail typed by hand reads as a phone number, which stays behind.
const PHONE = /\+?\d(?:[\s-]?\d){7,}/;
// A status written again within a minute, as a delivery saved twice, is one scan.
const REPEAT_MS = 60_000;
const MAX_WEIGHT_KG = 100_000;
// Markup in a field is a changed reply; a status's " => " is not.
const MARKUP = /<[a-z!/]/i;

/** A reference as the tracker takes it: five to forty letters and digits, with a digit, and every hyphen it carries. */
export function normalizeZmcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? carrierTrackingNumber(raw, PROVIDER) : '';
  if (number.length < ZMC_MIN_LENGTH || number.length > ZMC_MAX_LENGTH || !ZMC_REFERENCE.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Enter the ZMC Express reference number with its hyphens');
  }
  return number;
}

/** The tracker's answer that it holds no shipment under the reference asked: the body `error` alone. */
export function isZmcNotFound(body: string): boolean {
  return body.trim() === NOT_FOUND;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field: absent, null or a string of at most `max` characters; anything else is a changed reply. */
function text(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || MARKUP.test(value)) return invalid(`ZMC Express returned an invalid ${key}`);
  return clean(value, max);
}

/** The references `CustomerRefNo` joins with " | ", uppercased. */
function references(value: string): string[] {
  return value.split('|').map((part) => part.replace(/\s/g, '').toUpperCase()).filter(Boolean);
}

/**
 * A row's clock. The tracker writes a wall clock with no zone, the clock of the branch that wrote
 * the row. A warehouse in China, Guangzhou's, is on China's clock. A warehouse in Iraq, or a row
 * that names Iraq, as its customs and its COD warehouses do, is on Iraq's, and any other row on
 * ZMC Express's own, Iraq's too. Dubai's warehouse keeps that clock: minutes before its row, the
 * branch writes a customs row that names no place, and on two clocks the pair would swap.
 */
function scanClock(local: string, status: string, warehouse: string): Pick<CarrierEvent, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const country = warehouse ? locatePlace(warehouse)?.country : undefined;
  const [zone, basis] = country === 'CN' ? [CHINA_ZONE, 'place']
    : [HOME_ZONE, country === 'IQ' || IRAQ.test(status) ? 'place' : 'carrier'];
  const time = isoTime(local, zone);
  if (!time) return invalid('ZMC Express returned an invalid scan clock');
  return { local_time: local, time: time.iso, time_zone: zone, time_zone_basis: basis };
}

interface Row { at: number; index: number; key: string; reference: string; event: CarrierEvent }

/** One row of the reply: a scan, bound to the reference asked by `CustomerRefNo`. */
function readRow(row: unknown, index: number, number: string): Row {
  if (!isRecord(row)) return invalid('ZMC Express returned an invalid row');
  const reference = text(row, 'CustomerRefNo', 200);
  if (!reference) return invalid('ZMC Express returned a row without its reference');
  // The tracker finds a shipment by any of the references it joins, and must name the whole one asked.
  if (!references(reference).includes(number)) throw new IndeterminateError(PROVIDER, 'ZMC Express answered for another shipment');
  const status = text(row, 'Status', 300);
  if (!status) return invalid('ZMC Express returned a row without its status');
  const rawCode = row.StatusCode;
  const code = typeof rawCode === 'number' && Number.isInteger(rawCode) ? String(rawCode) : typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!CODE.test(code)) return invalid('ZMC Express returned an invalid status code');
  const registered = text(row, 'RegDate', 32);
  const local = CLOCK.test(registered) ? registered.replace(' ', 'T') : '';
  if (!local || !DateTime.fromISO(local, { zone: 'UTC' }).isValid) return invalid('ZMC Express returned an invalid scan clock');

  const wording = zmcWording(status);
  if (!wording) return invalid('ZMC Express returned a row without its status');
  const detail = status.slice(wording.length).replace(/^\s*(?:=>|\|)\s*/, '').trim();
  const warehouse = WAREHOUSE_CODES.has(code) && !PHONE.test(detail) ? detail : '';
  // The warehouse becomes the place; another detail, a flight, a trip, a country or a reason, stays in the wording.
  const kept = warehouse || !detail || PHONE.test(detail) ? wording : status;
  const clock = scanClock(local, status, warehouse);
  const staged = zmcStage(code, status);
  const event: CarrierEvent = { ...clock, description: kept, ...(warehouse ? { location: warehouse, original_description: status } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}), provider_code: code };
  return { at: Date.parse(`${local}Z`), index, key: JSON.stringify([code, kept, warehouse]), reference: references(reference).join('|'), event };
}

/** The shipment's weight in kilograms, the page's `TotalWeight` with its KG; absent when the row gives none. */
function weight(row: Record<string, unknown>): number | undefined {
  const value = row.TotalWeight;
  const kg = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}(?:\.\d{1,3})?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(kg) && kg > 0 && kg <= MAX_WEIGHT_KG ? kg : undefined;
}

/**
 * `getTrack1.php`'s reply for one reference: a JSON array, one row per scan, newest first. Each
 * row repeats the shipment's references, joined with " | " in `CustomerRefNo`, its recipient's
 * name and phone, its destination town, pieces, boxes and weight, and gives the scan's wall
 * clock (`RegDate`), status and status code. Every row must name the whole reference asked. The
 * recipient's name and phone, the town and the other reference stay behind.
 */
export function parseZmc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZmcNumber(raw);
  if (!Array.isArray(payload)) return invalid('ZMC Express returned an unexpected reply');
  // The tracker answers a reference it does not hold with `error`, never with an empty list.
  if (!payload.length) return invalid('ZMC Express returned no rows');
  if (payload.length > MAX_ROWS) return invalid('ZMC Express returned an invalid history');
  const rows = (payload as unknown[]).map((row, index) => readRow(row, index, number));
  // A reference two shipments share is no one shipment's.
  if (new Set(rows.map((row) => row.reference)).size > 1) throw new IndeterminateError(PROVIDER, 'ZMC Express answered for several shipments');

  // Oldest first by the wall clocks, as the tracker orders its rows across its branches' clocks;
  // rows written in the same second keep the reply's order, the later row older.
  const oldestFirst = [...rows].sort((a, b) => a.at - b.at || b.index - a.index);
  const kept: Row[] = [];
  for (const row of oldestFirst) {
    const previous = kept.at(-1);
    if (previous && previous.key === row.key && row.at - previous.at < REPEAT_MS) continue;
    kept.push(row);
  }
  const events = kept.reverse().map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const kg = weight(payload[0] as Record<string, unknown>);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead!.time ? { delivered_at: lead!.time } : {}),
    ...(kg === undefined ? {} : { weight_kg: kg }),
    events,
  };
}
