import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { cuLinesStage } from './status.js';

export const PROVIDER = 'CU Lines';
/** The eService the tracking page reads, answered with JSON whatever its content type says. */
export const CU_LINES_API = 'https://eservice.culines.com/gnoss/CUP_HOM_3301GS.do';
export const CU_LINES_MAX_BYTES = 2_000_000;
/** The containers of a booking whose own moves are asked; the others keep their latest move. */
export const MAX_DETAILS = 3;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// The bookings and bills customers hold are CUL, four letters and seven digits: CULV, the port of
// loading's code and a serial that starts with the year. The tracking page takes fourteen
// characters for them.
const BOOKING = /^CUL[A-Z]{4}\d{7}$/;
// The line's own references for a booking and for a container's cycle under it.
const REFERENCE = /^[A-Z0-9]{8,20}$/;
const MAX_ROWS = 500;

/** What CU Lines tracks: a booking or bill of lading, or a container by its ISO 6346 number. */
export type CuLinesQuery = { kind: 'booking' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a booking or bill of fourteen characters. */
export function cuLinesQuery(raw: string): CuLinesQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  if (BOOKING.test(number)) return { kind: 'booking', number };
  throw new InvalidInputError(PROVIDER, 'CU Lines tracks a booking or bill of lading such as CUL, four letters and seven digits, or a container number');
}

/** The eService's form for one of its commands, in the tracking page's field order. */
export type CuLinesForm =
  | { f_cmd: '122'; cntr_no: string }
  | { f_cmd: '121'; search_type: 'B' | 'C'; search_name: string }
  | { f_cmd: '125'; cntr_no: string; bkg_no: string; cop_no: string };

type Row = Record<string, unknown>;
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A field's text with its spaces collapsed, or '' where the reply leaves it out or puts `{}` in its place. */
function text(row: Row, key: string, max = 300): string {
  const value = row[key];
  if (value === undefined || value === null || isRecord(value) && !Object.keys(value).length) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `CU Lines returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A reply's rows once it says it succeeded, or null for its answer to a number it holds nothing
 * under: a success with no rows and nothing else. Any other reply without rows has changed.
 */
function rows(reply: unknown): { rows: Row[]; more: boolean } | null {
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'CU Lines returned a reply that is not an object');
  if (reply.TRANS_RESULT_KEY !== 'S') throw new SchemaError(PROVIDER, 'CU Lines refused the request');
  if (reply.Exception !== '') throw new SchemaError(PROVIDER, 'CU Lines answered with an error');
  const count = typeof reply.count === 'string' && /^\d{1,6}$/.test(reply.count) ? Number(reply.count) : NaN;
  if (!Number.isInteger(count)) throw new SchemaError(PROVIDER, 'CU Lines returned an invalid count');
  if (count === 0 && Object.keys(reply).length === 3) return null;
  const list = reply.list;
  if (!Array.isArray(list) || !list.length || list.length > MAX_ROWS || list.length > count || !list.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'CU Lines returned an invalid list');
  }
  return { rows: list, more: list.length < count };
}

function reference(row: Row, key: string): string {
  const value = text(row, key, 30);
  if (!REFERENCE.test(value)) throw new SchemaError(PROVIDER, `CU Lines returned an invalid ${key}`);
  return value;
}

const MOVE_DATE = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

/** A move's wall clock: CU Lines gives the place's time without its offset. */
function wallClock(date: string): string {
  const parts = MOVE_DATE.exec(date);
  const local = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:00` : '';
  const year = Number(parts?.[1]);
  if (!parts || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'CU Lines returned an invalid event time');
  return local;
}

/** The yard, then its town and country as CU Lines writes them, with a comma between them. */
function place(row: Row): string | undefined {
  const yard = text(row, 'yardNm').replace(/[\s,;]+$/, '');
  const town = text(row, 'placeNm').replace(/\s*,\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  const parts = [yard, town].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

type Move = CarrierEvent & { local_time: string; provider_code: string };

/** A move from its row: its wording as CU Lines gives it, staged by its code. */
function move(row: Row): Move {
  const description = text(row, 'statusNm');
  const code = text(row, 'statusCd', 20);
  if (!description || !/^[A-Z]{6}$/.test(code)) throw new SchemaError(PROVIDER, 'CU Lines returned a move without its status');
  const location = place(row);
  const stage = cuLinesStage(code);
  return { local_time: wallClock(text(row, 'eventDt', 20)), ...(location ? { location } : {}), description, provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);

/** One cycle of a container: the booking it travels under and the line's reference for the cycle. */
export type CuLinesCycle = { bkgNo: string; copNo: string };

/**
 * The bookings a container has travelled under, from the eService's container search, or null
 * when CU Lines holds none. The rows do not name the container.
 */
export function cuLinesCycles(reply: unknown): CuLinesCycle[] | null {
  const found = rows(reply);
  return found ? found.rows.map(row => ({ bkgNo: reference(row, 'bkgNo'), copNo: reference(row, 'copNo') })) : null;
}

/**
 * The container's latest cycle among those its search listed, by the newest move of each in the
 * booking search's rows for the container, or the first listed, as the tracking page takes, when
 * those rows date none of them. Rows of other containers say nothing about it.
 */
export function cuLinesLatestCycle(reply: unknown, container: string, cycles: readonly CuLinesCycle[]): CuLinesCycle {
  const dated = (rows(reply)?.rows ?? []).flatMap(row => {
    if (text(row, 'cntrNo', 20) !== container) return [];
    const copNo = reference(row, 'copNo');
    const cycle = cycles.find(item => item.copNo === copNo);
    const date = text(row, 'eventDt', 20);
    return cycle && date ? [{ cycle, at: wallClock(date) }] : [];
  });
  return dated.sort((left, right) => right.at.localeCompare(left.at))[0]?.cycle ?? cycles[0]!;
}

/** A container of a booking: its number, its cycle and its latest move. */
export type CuLinesContainer = CuLinesCycle & { number: string; latest: Move | null };
/** A booking's or a container's containers, and whether CU Lines listed fewer than it holds. */
export type CuLinesShipment = { containers: CuLinesContainer[]; more: boolean };

/**
 * A booking's containers from the eService's booking search, each named under the booking asked,
 * by its own number or the one CU Lines displays, or null when CU Lines holds none.
 */
export function cuLinesShipment(reply: unknown, booking: string): CuLinesShipment | null {
  const found = rows(reply);
  if (!found) return null;
  const seen = new Set<string>();
  const containers = found.rows.map(row => {
    if (text(row, 'bkgNo', 30) !== booking && text(row, 'dspBkgNo', 30) !== booking) throw new SchemaError(PROVIDER, 'CU Lines returned another booking');
    const number = text(row, 'cntrNo', 20);
    if (!CONTAINER.test(number) || seen.has(number)) throw new SchemaError(PROVIDER, 'CU Lines returned an invalid container');
    seen.add(number);
    return { number, bkgNo: reference(row, 'bkgNo'), copNo: reference(row, 'copNo'), latest: text(row, 'statusNm') ? move(row) : null };
  });
  return { containers, more: found.more };
}

/**
 * A container's actual moves in a cycle, from the eService's move list. The list holds the moves
 * of the cycle asked whatever container is named, so each must carry its reference. Moves CU Lines
 * only estimates are left out.
 */
export function cuLinesMoves(reply: unknown, copNo: string): { moves: Move[]; more: boolean } {
  const found = rows(reply);
  if (!found) return { moves: [], more: false };
  const moves: Move[] = [];
  for (const row of found.rows) {
    if (text(row, 'copNo', 30) !== copNo) throw new SchemaError(PROVIDER, 'CU Lines returned the moves of another container');
    const kind = text(row, 'actTpCd', 2);
    if (kind !== 'A' && kind !== 'E') throw new SchemaError(PROVIDER, 'CU Lines returned a move that is neither actual nor estimated');
    if (kind === 'A') moves.push(move(row));
  }
  return { moves, more: found.more };
}

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's moves newest first. The list gives them along the route, which ties keep. A gate
 * in after the container moved is transit; an empty container returned before it moved was not
 * used, which is no delivery.
 */
function containerHistory(moves: readonly Move[]): Move[] {
  const events = [...moves].reverse().sort(newestFirst);
  let moved = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'delivered' && !moved) {
      delete (event as CarrierEvent).stage;
      delete (event as CarrierEvent).stage_source;
    } else if (moved && event.stage && BEFORE_MOVING.has(event.stage)) {
      event.stage = 'in_transit';
    }
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
  }
  return events;
}

/**
 * The stage the shipment is at. A booking's containers move apart: one returned empty does not
 * make the others delivered, so a delivery decides only once every container has one, and a
 * container without a staged move leaves the stage open.
 */
function currentStage(histories: readonly Move[][]): Stage | undefined {
  const latest = histories.map(events => events.find(event => event.stage)).filter((event): event is Move => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

/**
 * The shipment from its containers: each one's moves where they were asked, its latest move
 * otherwise, merged newest first with the moves they share kept once.
 */
export function cuLinesResult(shipment: CuLinesShipment | null, details: ReadonlyMap<string, { moves: readonly Move[]; more: boolean }> = new Map()): CarrierResult {
  if (!shipment) throw new NotFoundError(PROVIDER, 'CU Lines does not hold this number');
  let truncated = shipment.more;
  const histories = shipment.containers.map(container => {
    const detail = details.get(container.number);
    if (detail) {
      truncated ||= detail.more;
      return containerHistory(detail.moves);
    }
    truncated ||= container.latest !== null;
    return container.latest ? [{ ...container.latest }] : [];
  });
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'CU Lines lists the shipment without moves', { reason: 'listed' });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, ...(truncated || events.length > MAX_ROWS ? { history_truncated: true } : {}), events: events.slice(0, MAX_ROWS),
  };
}

// Bot checks a CDN or firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|acw_sc__v2|aliyun_waf|_waf_|captcha/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function cuLinesJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'CU Lines answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'CU Lines returned a reply that is not JSON', { cause });
  }
}
