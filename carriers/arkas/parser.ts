import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvents } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { arkasStage } from './status.js';

export const PROVIDER = 'Arkas Line';
export const ARKAS_ORIGIN = 'https://webtrackingprodnew.arkasline.com.tr';
/** The shipment tracking page that arkasline.com.tr frames. */
export const ARKAS_TRACKER = `${ARKAS_ORIGIN}/shipmenttracking`;
/** The page's own relay to the tracking service, which names the service's method and its parameters. */
export const ARKAS_API = `${ARKAS_ORIGIN}/api/request/Get`;
export const ARKAS_MAX_BYTES = 1_000_000;

const SERVICE = 'webtracking/api/shipmenttracking/';
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const MAX_DOCUMENTATIONS = 50;
const MAX_MOVES = 300;

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number whose check digit matches. */
export function arkasQuery(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!CONTAINER.test(number)) throw new InvalidInputError(PROVIDER, 'Arkas Line tracks a container by its ISO 6346 number');
  if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
  return number;
}

const serviceUrl = (method: string, parameters: JsonObject) =>
  `${ARKAS_API}?${new URLSearchParams([['controllerMethod', `${SERVICE}${method}`], ['prms', JSON.stringify(parameters)]])}`;

/** The search of the tracking page, which lists the documentations a number belongs to. */
export const arkasSearchUrl = (number: string) => serviceUrl('GetDocumentationAsync', { key: number });

/** The moves of one documentation, which the page asks when a result row is opened. */
export const arkasHistoryUrl = (documentationId: number) => serviceUrl('GetDocumentationHistoryAsync', { documentationId });

const REFUSED = /<title>\s*(?:Just a moment|Attention Required! \| Cloudflare|Access denied)|_cf_chl_opt|cf-turnstile|Sorry, you have been blocked/i;

/** A reply's JSON, or the error a page in its place stands for. */
export function arkasJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (REFUSED.test(body.slice(0, 100_000))) throw new ChallengeError(PROVIDER, 'Cloudflare refused Arkas Line\'s tracking request');
    throw new SchemaError(PROVIDER, 'Arkas Line returned a reply that is not JSON');
  }
}

function text(row: JsonObject, key: string, max = 300): string {
  const value = row[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, `Arkas Line returned an invalid ${key}`);
  return value.replace(/\s+/g, ' ').trim();
}

// The tracking service's answer for a number it does not hold.
const UNKNOWN = /^No matching tracking information\b/i;
const RECORDED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * The documentation of the container's latest cycle from the tracking page's search, or null for
 * the service's answer that it holds no such number. Each row must name the container asked; of
 * several, the one with the latest recorded move is read.
 */
export function arkasDocumentation(reply: unknown, container: string): number | null {
  const found = isRecord(reply) ? reply.data : undefined;
  const rows = isRecord(found) ? found.data : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_DOCUMENTATIONS || !rows.every(isRecord)) throw new SchemaError(PROVIDER, 'Arkas Line returned no list of documentations');
  if (!rows.length) {
    if (UNKNOWN.test(text(found as JsonObject, 'message', 500))) return null;
    throw new SchemaError(PROVIDER, 'Arkas Line returned an empty list without its message');
  }
  const documentations = rows.map(row => {
    if (text(row, 'containerNo', 20) !== container) throw new IndeterminateError(PROVIDER, 'Arkas Line answered for another container');
    const id = row.documentationId;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new SchemaError(PROVIDER, 'Arkas Line returned an invalid documentation');
    const recorded = text(row, 'lastRecordedDate', 40);
    return { id, recorded: RECORDED.test(recorded) ? recorded : '' };
  });
  return documentations.reduce((latest, documentation) => documentation.recorded > latest.recorded ? documentation : latest).id;
}

/** A move as the service lists it, before the cycle stages it. */
export type ArkasMove = CarrierEvent & { local_time: string; description: string };

const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,7})?)?$/;

/** A move's wall clock: the service states no zone for it. */
function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const local = parts ? `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}` : '';
  const year = Number(parts?.[1]);
  if (!parts || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Arkas Line returned an invalid move time');
  return local;
}

/** The facility, then its port when the facility's name does not already hold it. */
function place(terminal: string, port: string): string {
  const upper = (value: string) => value.toLocaleUpperCase('en-US');
  if (!port || upper(terminal).includes(upper(port))) return terminal;
  return terminal ? `${terminal}, ${port}` : port;
}

/** A documentation's moves: those that happened, oldest first, and those the service only estimates. */
export function arkasMoves(reply: unknown): { moves: ArkasMove[]; estimated: ArkasMove[] } {
  const rows = isRecord(reply) ? reply.data : undefined;
  if (!Array.isArray(rows) || rows.length > MAX_MOVES || !rows.every(isRecord)) throw new SchemaError(PROVIDER, 'Arkas Line returned no list of moves');
  const moves: ArkasMove[] = [];
  const estimated: ArkasMove[] = [];
  for (const row of rows) {
    if (typeof row.isDummy !== 'boolean') throw new SchemaError(PROVIDER, 'Arkas Line returned a move without saying whether it happened');
    const description = text(row, 'status');
    if (!description) throw new SchemaError(PROVIDER, 'Arkas Line returned a move without its wording');
    const location = place(text(row, 'terminal'), text(row, 'port'));
    const stage = arkasStage(description);
    (row.isDummy ? estimated : moves).push({ local_time: wallClock(text(row, 'eventDate', 40)), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) });
  }
  return { moves, estimated };
}

// The stages of a container that has not moved yet.
const BEFORE_MOVING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * The cycle's moves newest first, staged by their place in it. An empty container returned
 * before it moved was not used, which is no delivery. After the container moved, an empty one's
 * gate out is transit, and once the cargo went out for delivery it stays so until the return.
 */
function cycleHistory(moves: readonly ArkasMove[]): ArkasMove[] {
  const events = moves.map((move, index) => ({ move: { ...move }, index }))
    .sort((left, right) => right.move.local_time.localeCompare(left.move.local_time) || right.index - left.index).map(({ move }) => move);
  let moved = false;
  let out = false;
  for (const event of [...events].reverse()) {
    if (event.stage === 'delivered' && !moved) {
      delete (event as CarrierEvent).stage;
      delete (event as CarrierEvent).stage_source;
    } else if (moved && event.stage && BEFORE_MOVING.has(event.stage)) {
      event.stage = out ? 'out_for_delivery' : 'in_transit';
    }
    if (event.stage && !BEFORE_MOVING.has(event.stage)) moved = true;
    if (event.stage === 'out_for_delivery') out = true;
  }
  return events;
}

/**
 * The container's latest cycle: its moves newest first, staged by the cycle, and the moves the
 * service only estimates as planned steps. A documentation without a move that happened is a
 * container Arkas lists without history.
 */
export function arkasResult(found: { moves: readonly ArkasMove[]; estimated: readonly ArkasMove[] } | null): CarrierResult {
  if (!found) throw new NotFoundError(PROVIDER, 'Arkas Line does not hold this container');
  const steps = plannedEvents(found.estimated);
  if (!found.moves.length) {
    throw new NoHistoryError(PROVIDER, 'Arkas Line lists the container without moves', { reason: 'listed', ...(steps.length ? { plannedEvents: steps } : {}) });
  }
  const events = cycleHistory(found.moves);
  const newest = events[0]!;
  const stage = events.find(event => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, ...(steps.length ? { planned_events: steps } : {}), events,
  };
}
