import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { milahaStage } from './status.js';

export const PROVIDER = 'Milaha';
// The tracker's pages are tens of kilobytes; a booking lists each of its containers.
export const MILAHA_MAX_BYTES = 1024 * 1024;

/** What the tracker looks up: a container by its ISO 6346 number, or a booking or bill of lading. */
export interface MilahaQuery { readonly kind: 'container' | 'booking'; readonly number: string }

/** A booking's container as the tracker lists it, with the booking its moves are kept under. */
export interface MilahaContainer {
  readonly number: string;
  readonly booking: string;
  /** Its latest move, which the list shows when the container's own moves are not read. */
  readonly latest: CarrierEvent | null;
}

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// A booking, which is also its bill: MIL or QNL, the office's country, a digit, sometimes a port, then the serial.
const BOOKING = /^(?:MIL|QNL)[A-Z]{2}\d[A-Z0-9]{6,12}$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DATE = /^(\d{2})-([A-Za-z]{3})-(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
// The script the tracker adds for a number it holds nothing for, naming the number.
const INVALID = /var invalidid = "([^"]{0,200})";/;
const CARD = /<div class="card card-body[^"]*\bcontainer_track_mail\b[^"]*">/g;
const ROW = /<tr>([\s\S]*?)<\/tr>/g;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
const OPEN_MOVES = /ContainerInfoNew\('([A-Z0-9]{1,20})',\s*'([A-Z0-9]{1,30})'/;
const MOVE = /<div class="media">([\s\S]*?)(?=<div class="media">|$)/g;
const MAX_CONTAINERS = 200;
const MAX_MOVES = 300;
const MAX_EVENTS = 200;

// ISO 6346 values letters from 10 up, skipping multiples of 11.
const LETTER_VALUES: ReadonlyMap<string, number> = (() => {
  const values = new Map<string, number>();
  let value = 10;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (value % 11 === 0) value++;
    values.set(letter, value++);
  }
  return values;
})();

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  return [...body].reduce((sum, char, index) => sum + (LETTER_VALUES.get(char) ?? Number(char)) * 2 ** index, 0) % 11 % 10;
}

/** The lookup for a number: a container with its check digit, or a Milaha booking or bill of lading. */
export function milahaQuery(raw: string): MilahaQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) {
      throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    }
    return { kind: 'container', number };
  }
  if (BOOKING.test(number)) return { kind: 'booking', number };
  throw new InvalidInputError(PROVIDER, 'Milaha tracks a container number, or a booking or bill of lading from MIL or QNL');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const field = (html: string, name: string, max = 120) =>
  textFromHtml(new RegExp(`class="[^"]*\\b${name}\\b[^"]*">([^<]*)<`).exec(html)?.[1] ?? '', max);

/** A move's day and minute on the port's wall clock, as `2026-08-06T11:29`. */
function wallClock(value: string): string {
  const parts = DATE.exec(value);
  const month = parts ? MONTHS.indexOf(parts[2]!.toUpperCase()) + 1 : 0;
  const day = parts && month ? calendarDay(Number(parts[3]), month, Number(parts[1])) : null;
  return day ? `${day}T${parts![4]}:${parts![5]}` : invalid('Milaha returned an invalid move date');
}

/** A move with its wording's stage, if Milaha's map knows the wording. */
function move(description: string, localTime: string, location: string): CarrierEvent {
  const stage = milahaStage(description);
  return { local_time: localTime, description, ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/**
 * The containers the tracker lists for the number asked: each container of a booking, or the
 * container itself under its latest booking. The tracker's script that names an invalid number,
 * without a booking, is its not-found answer.
 */
export function parseMilahaDetails(html: string, query: MilahaQuery): MilahaContainer[] {
  const starts = [...html.matchAll(CARD)].map(match => match.index);
  if (!starts.length) {
    if (INVALID.test(html)) throw new NotFoundError(PROVIDER, 'Milaha has no booking or movement for this number');
    return invalid('Milaha returned a tracking page without a booking');
  }
  const containers: MilahaContainer[] = [];
  let asked = false;
  for (const [index, start] of starts.entries()) {
    const card = html.slice(start, starts[index + 1] ?? html.length);
    const numbers = [field(card, 'mail_bkgno', 40), field(card, 'mail_blno', 40)].map(value => normalizeTrackingNumber(value));
    if (!numbers[0]) return invalid('Milaha returned a booking without its number');
    const listed: MilahaContainer[] = [];
    for (const [, row] of card.matchAll(ROW)) {
      const cells = [...row!.matchAll(CELL)].map(([, cell]) => cell!);
      if (cells.length < 6) continue;
      const opens = OPEN_MOVES.exec(cells[5]!);
      const number = textFromHtml(cells[0], 20);
      if (!opens || opens[1] !== number || !CONTAINER.test(number)) return invalid('Milaha returned a container without its number');
      const activity = textFromHtml(cells[1], 120), location = textFromHtml(cells[2], 120), date = textFromHtml(cells[4], 40);
      listed.push({ number, booking: opens[2]!, latest: activity && date ? move(activity, wallClock(date), location) : null });
    }
    if (query.kind === 'booking' ? numbers.includes(query.number) : listed.some(item => item.number === query.number)) {
      asked = true;
      containers.push(...(query.kind === 'booking' ? listed : listed.filter(item => item.number === query.number)));
    }
  }
  if (!asked) throw new IndeterminateError(PROVIDER, `Milaha answered for another ${query.kind}`);
  if (containers.length > MAX_CONTAINERS) return invalid('Milaha returned too many containers');
  return containers;
}

/** A container's moves, the newest first, as the tracker's movement panel lists them. */
export function parseMilahaMoves(html: string): CarrierEvent[] {
  if (!/class="media-header">\s*Movement Details/.test(html)) return invalid('Milaha returned an invalid movement panel');
  const moves = [...html.matchAll(MOVE)];
  if (moves.length > MAX_MOVES) return invalid('Milaha returned too many moves');
  return moves.map(([, block]) => {
    const description = textFromHtml(/class="movement_title">([^<]*)</.exec(block!)?.[1] ?? '', 120);
    const date = textFromHtml(/class="date_track">([^<]*)</.exec(block!)?.[1] ?? '', 40);
    if (!description || !date) return invalid('Milaha returned a move without its name or date');
    const location = textFromHtml(/Activity Location:\s*<\/label>\s*<span>([^<]*)</.exec(block!)?.[1] ?? '', 120);
    return move(description, wallClock(date), location);
  });
}

type Ordered = { event: CarrierEvent; order: number };
// The newest first; moves at one minute keep the panel's order, which lists the later first.
const newestFirst = (left: Ordered, right: Ordered) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : left.order - right.order;

/**
 * The move whose stage the shipment is at. A booking's containers move apart: one returned
 * empty does not make the others delivered, so a delivery decides only once every container has one.
 */
function currentMove(containers: readonly (readonly CarrierEvent[])[]): CarrierEvent | undefined {
  const latest = containers.map(events => events.map((event, order) => ({ event, order }))
    .filter(({ event }) => event.stage).sort(newestFirst)[0]?.event);
  const open = latest.filter(event => event?.stage !== 'delivered');
  const candidates = (open.length ? open : latest).filter((event): event is CarrierEvent => event !== undefined);
  return candidates.map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/**
 * The shipment from its containers' moves, each container's newest first. A container whose
 * moves were not read keeps the latest move the booking's list shows for it.
 */
export function milahaResult(containers: readonly (readonly CarrierEvent[])[], truncated = false): CarrierResult {
  const seen = new Set<string>();
  const events = containers.flatMap((moves, index) => moves.map((event, row) => ({ event, order: index * MAX_MOVES + row })))
    .sort(newestFirst)
    // A booking's containers share their vessel's moves: each is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Milaha lists the booking without moves', { reason: 'listed' });
  const newest = events[0]!;
  const current = currentMove(containers);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(truncated || events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
