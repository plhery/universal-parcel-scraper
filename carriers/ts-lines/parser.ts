import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { isoTime } from '../../core/time/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { tsLinesStage } from './status.js';

export const PROVIDER = 'T.S. Lines';
/** The service behind T.S. Lines' cargo tracking page, answered with JSON. */
export const TS_LINES_API = 'https://epd.tslines.com/v1';
export const TS_LINES_MAX_BYTES = 2_000_000;
/** The containers of a bill whose own moves are asked; the others keep their latest move. */
export const MAX_DETAILS = 3;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const BILL = /^\d{12}$/;
const MAX_ROWS = 500;
const MAX_SVG = 65_536;

/** What T.S. Lines' tracker takes: a bill of lading of twelve digits, or a container by its ISO 6346 number. */
export type TsLinesQuery = { kind: 'bill' | 'container'; number: string };

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, or a bill of twelve digits. */
export function tsLinesQuery(raw: string): TsLinesQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  if (BILL.test(number)) return { kind: 'bill', number };
  throw new InvalidInputError(PROVIDER, 'T.S. Lines tracks a bill of lading of twelve digits or a container number');
}

// Each digit's glyph is one path whose subpaths, split at Z, hold these numbers of quadratic curves.
const DIGITS: ReadonlyMap<string, string> = new Map([
  ['6,7,13,14,3,4', '0'], ['8,12', '1'], ['22,29', '2'], ['32,45', '3'], ['4,13,20,5', '4'],
  ['21,30', '5'], ['9,15,21,8', '6'], ['17,22', '7'], ['8,7,15,21,9,7', '8'], ['8,17,20,11', '9'],
]);
// A glyph is drawn with moves, lines and quadratic curves only, so its numbers come in x,y pairs.
const GLYPH = /^M[\d\s.,MLQZ-]*Z$/;

/**
 * The code of the tracker's captcha. Its SVG draws four filled glyph paths, one digit each, and
 * unfilled noise strokes. A glyph is read by the curves of its subpaths, and the digits are read
 * from left to right by each glyph's leftmost point. No raster OCR or guessing.
 */
export function tsLinesCaptchaCode(svg: string): string {
  const unreadable = () => new ChallengeError(PROVIDER, 'T.S. Lines changed its verification image', { reason: 'puzzle_unsolved' });
  if (typeof svg !== 'string' || svg.length > MAX_SVG) throw unreadable();
  const $ = load(svg, { xmlMode: true });
  if ($('svg').length !== 1) throw unreadable();
  const glyphs = $('svg > path').toArray().filter(node => ($(node).attr('fill') ?? 'none') !== 'none').map(node => {
    const path = ($(node).attr('d') ?? '').trim();
    const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (!GLYPH.test(path) || !numbers.length || numbers.length % 2) throw unreadable();
    const curves = path.split('Z').slice(0, -1).map(part => part.split('Q').length - 1).join(',');
    return { x: Math.min(...numbers.filter((_, index) => index % 2 === 0)), digit: DIGITS.get(curves) };
  });
  if (glyphs.length !== 4 || glyphs.some(glyph => !glyph.digit || !Number.isFinite(glyph.x))
    || new Set(glyphs.map(glyph => glyph.x)).size !== 4) throw unreadable();
  return glyphs.sort((left, right) => left.x - right.x).map(glyph => glyph.digit).join('');
}

/** A captcha to answer: its single-use token and the code its image shows. */
export function tsLinesCaptcha(reply: unknown): { token: string; code: string } {
  if (!isRecord(reply) || typeof reply.captchaSVG !== 'string' || typeof reply.captchaToken !== 'string' || !/^[\w.:-]{8,200}$/.test(reply.captchaToken)) {
    throw new ChallengeError(PROVIDER, 'T.S. Lines returned no verification image', { reason: 'puzzle_missing' });
  }
  return { token: reply.captchaToken, code: tsLinesCaptchaCode(reply.captchaSVG) };
}

const BLOCKED = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|cf-chl-|cf_chl_|_Incapsula_Resource|errors\.edgesuite\.net/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function tsLinesJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (BLOCKED.test(body)) throw new ChallengeError(PROVIDER, 'A bot check refused T.S. Lines\' tracking request', { reason: 'api_denied' });
    throw new SchemaError(PROVIDER, 'T.S. Lines returned a reply that is not JSON');
  }
}

/** Whether a refused search says its captcha code was wrong. */
export function captchaRejected(reply: unknown): boolean {
  return isRecord(reply) && typeof reply.message === 'string' && /^captcha code invalid\.?$/i.test(reply.message.trim());
}

function text(row: JsonObject, key: string, max = 300): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `T.S. Lines returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

/** A reply's list of rows, which a reply always carries, empty when T.S. Lines holds nothing. */
function rows(reply: unknown, key: string): JsonObject[] {
  const value = isRecord(reply) ? reply[key] : undefined;
  if (!Array.isArray(value) || value.length > MAX_ROWS || !value.every(isRecord)) throw new SchemaError(PROVIDER, `T.S. Lines returned no ${key} list`);
  return value;
}

type Move = CarrierEvent & { local_time: string; description: string };

const CLOCK = /^(\d{4})\/(\d{2})\/(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** A move's wall clock: T.S. Lines states no zone for it. */
function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const local = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}` : '';
  const year = Number(parts?.[1]);
  if (!parts || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'T.S. Lines returned an invalid move time');
  return local;
}

/** A move from a row: its wording, wall clock, and facility with the country. */
function move(row: JsonObject, clock: string, facility: string): Move {
  const description = text(row, 'ACTIVITY');
  if (!description) throw new SchemaError(PROVIDER, 'T.S. Lines returned a move without wording');
  // The container rows spell the country's key COURNTRY.
  const location = [text(row, facility), text(row, 'COURNTRY') || text(row, 'COUNTRY')].filter(Boolean).join(', ');
  const stage = tsLinesStage(description);
  return { local_time: wallClock(text(row, clock, 25)), description, ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

/** A container's latest move under a bill, or in a cycle no bill names yet. */
export type TsLinesCycle = { number: string; bill: string | null; latest: Move };

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);

/**
 * The latest cycle of a container from the tracker's container search, which lists one row for
 * each shipment the container carried; or null when T.S. Lines lists none. The row names the
 * cycle's bill once one is issued.
 */
export function tsLinesContainer(reply: unknown, container: string): TsLinesCycle | null {
  const cycles = rows(reply, 'cargoOnTheWay').map(row => {
    if (text(row, 'CONTAINERNUMBER', 20) !== container) throw new IndeterminateError(PROVIDER, 'T.S. Lines answered for another container');
    const bill = text(row, 'BL_NUMBER', 30) || null;
    if (bill !== null && !/^[A-Z\d]{6,20}$/.test(bill)) throw new SchemaError(PROVIDER, 'T.S. Lines returned an invalid bill');
    return { number: container, bill, latest: move(row, 'ACTIVETIME', 'LOCATION') };
  });
  return [...cycles].sort((left, right) => newestFirst(left.latest, right.latest))[0] ?? null;
}

/**
 * A bill's containers with their latest moves, from the tracker's bill search, or null when T.S.
 * Lines lists none. A container listed twice keeps its later move.
 */
export function tsLinesBill(reply: unknown, bill: string): TsLinesCycle[] | null {
  const containers = new Map<string, TsLinesCycle>();
  for (const row of rows(reply, 'cargos')) {
    if (text(row, 'BL_NUMBER', 30) !== bill) throw new IndeterminateError(PROVIDER, 'T.S. Lines answered for another bill');
    const number = text(row, 'CONTAINER_NUMBER', 20);
    if (!CONTAINER.test(number)) throw new SchemaError(PROVIDER, 'T.S. Lines returned an invalid container');
    const latest = move(row, 'ACTIVE_DATE', 'LOCATION_NAME');
    const known = containers.get(number);
    if (!known || latest.local_time > known.latest.local_time) containers.set(number, { number, bill, latest });
  }
  return containers.size ? [...containers.values()] : null;
}

/** A container's moves under a bill, from the tracker's history service, newest first. */
export function tsLinesHistory(reply: unknown, container: string): Move[] {
  return rows(reply, 'docs').map(row => {
    if (text(row, 'EQPA_CONTAINER', 20) !== container) throw new IndeterminateError(PROVIDER, 'T.S. Lines returned another container\'s moves');
    return move(row, 'EQPA_MOVE_DATE', 'LOCATION');
  });
}

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A cycle's moves newest first. A gate in after the container moved is transit; an empty
 * container returned before it moved was not used, which is no delivery.
 */
function cycleHistory(moves: readonly Move[]): Move[] {
  const events = [...moves].sort(newestFirst);
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

const wording = (event: Move) => normalizeStatusWording(event.description).replace(/\.$/, '');
const sameMove = (left: Move, right: Move) => left.local_time.slice(0, 16) === right.local_time.slice(0, 16) && wording(left) === wording(right);

/**
 * A container's history in its cycle. Without a bill, its latest move is the cycle's only known
 * move. Under a bill, its moves, with its latest move from the search where they lack it; a
 * container whose moves were not asked, or came back empty, keeps its latest move as the search
 * staged it, since a container listed under a bill served it.
 */
function containerHistory(cycle: TsLinesCycle, moves: readonly Move[] | undefined): Move[] {
  if (cycle.bill === null) return cycleHistory([cycle.latest]);
  if (!moves?.length) return [cycle.latest];
  return cycleHistory(moves.some(event => sameMove(event, cycle.latest)) ? moves : [...moves, cycle.latest]);
}

/**
 * The stage the shipment is at. A bill's containers move apart: one returned empty does not
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
 * The shipment from its containers: each one's moves under the bill, or its latest move where
 * they were not asked, merged newest first and those the containers share kept once.
 */
export function tsLinesResult(cycles: readonly TsLinesCycle[] | null, details: ReadonlyMap<string, readonly Move[]> = new Map()): CarrierResult {
  if (!cycles?.length) throw new NotFoundError(PROVIDER, 'T.S. Lines does not hold this number');
  const truncated = cycles.some(cycle => cycle.bill !== null && !details.has(cycle.number));
  const histories = cycles.map(cycle => containerHistory(cycle, details.get(cycle.number)));
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter(event => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, ...(truncated || events.length > MAX_ROWS ? { history_truncated: true } : {}), events: events.slice(0, MAX_ROWS),
  };
}
