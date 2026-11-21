import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { MOVES, vascoStage } from './status.js';

export const PROVIDER = 'Vasco Maritime';
// A bill's header and its containers' moves are each a few kilobytes.
export const VASCO_MAX_BYTES = 1024 * 1024;

/** What the tracker looks up: a bill of lading or a container. */
export interface VascoQuery {
  readonly kind: 'bill' | 'container';
  readonly number: string;
}

/** The bill the tracker answers with, and what the adapter reads its moves by. */
export interface VascoBill {
  readonly bill: string;
  readonly voyage: string;
  readonly containers: readonly string[];
  /** The place the container is first handed over, its ports of loading and discharge, and its final port. */
  readonly origin: string;
  readonly loading: string;
  readonly discharge: string;
  readonly final: string;
}

// A bill: the line's prefix, the codes of the ports of loading and of discharge, then a serial.
const BILL = /^[A-Z]{9}\d{5,7}$/;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const TIME = /^(\d{2})-([A-Z]{3})-(\d{4}) ([01]\d|2[0-3]):([0-5]\d):[0-5]\d$/;
const MAX_CONTAINERS = 200;
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

/** The lookup for a number: a bill of lading or a container with its check digit. */
export function vascoQuery(raw: string): VascoQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.-]/g, '') : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) {
      throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    }
    return { kind: 'container', number };
  }
  if (BILL.test(number)) return { kind: 'bill', number };
  throw new InvalidInputError(PROVIDER, 'Vasco Maritime tracks a bill of lading or a container');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The rows of a tracker reply: a JSON array, or `N` when the tracker refuses the request. */
function rows(body: string, what: string): Record<string, unknown>[] {
  const reply = body.trim();
  // The page reads `N` as an expired session; a guest request sends no session.
  if (reply === 'N') throw new TransportError(PROVIDER, `Vasco Maritime refused its ${what}`);
  if (!reply) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    return invalid(`Vasco Maritime returned an unreadable ${what}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) return invalid(`Vasco Maritime returned an invalid ${what}`);
  return parsed;
}

/** The bill a bill or container lookup answers with. An empty reply is the tracker's not-found answer. */
export function parseVascoBill(body: string, query: VascoQuery): VascoBill {
  const [row] = rows(body, query.kind === 'bill' ? 'bill' : 'container');
  if (!row) throw new NotFoundError(PROVIDER, `Vasco Maritime has no ${query.kind === 'bill' ? 'bill of lading' : 'container'} for this number`);
  const bill = text(row.BL_ID, 30);
  const voyage = typeof row.VOYAGE_ID === 'number' && Number.isSafeInteger(row.VOYAGE_ID) ? String(row.VOYAGE_ID) : text(row.VOYAGE_ID, 20);
  // The page lists the containers with line breaks between them.
  const containers = [...new Set(text(row.CONTAINER, 20 * MAX_CONTAINERS).split(/<br\s*\/?>|\s/i).filter(Boolean))];
  if (!bill || !/^\d{1,12}$/.test(voyage) || !containers.length || !containers.every(number => CONTAINER.test(number))) {
    return invalid('Vasco Maritime returned a bill without its numbers');
  }
  if (query.kind === 'bill' ? bill !== query.number : !containers.includes(query.number)) {
    throw new IndeterminateError(PROVIDER, `Vasco Maritime answered for another ${query.kind}`);
  }
  const discharge = text(row.POD, 80);
  return { bill, voyage, containers, origin: text(row.POO, 80) || text(row.POL, 80), loading: text(row.POL, 80), discharge,
    final: text(row.FPOD, 80) || discharge };
}

/** The port a move happens at, when the bill names it: transshipment moves only when the final port differs. */
function place(move: string, bill: VascoBill): string {
  switch (move) {
    case 'MT': return bill.origin;
    case 'LADEN': case 'LOADED_ON_BOARD': return bill.loading;
    case 'CONTAINER_DISCHARGED_TRANS': case 'CONTAINER_LOAD_TRANS': return bill.final !== bill.discharge ? bill.discharge : '';
    default: return bill.final;
  }
}

/**
 * Each container's moves, the newest first, on the ports' wall clocks: the asked container's
 * for a container lookup, every container's for a bill.
 */
export function parseVascoMoves(body: string, bill: VascoBill, query: VascoQuery): CarrierEvent[][] {
  const listed = rows(body, 'container moves');
  if (listed.length > MAX_CONTAINERS) return invalid('Vasco Maritime returned too many containers');
  const containers = listed.map(row => {
    const container = text(row.CONTAINER_NO, 20);
    if (!bill.containers.includes(container)) throw new IndeterminateError(PROVIDER, 'Vasco Maritime answered for another bill');
    return { container, events: MOVES.flatMap(({ code, wording }): CarrierEvent[] => {
      const value = row[code];
      if (value === null || value === undefined || value === '') return [];
      const parts = TIME.exec(text(value, 30));
      const month = parts ? MONTHS.indexOf(parts[2]!) + 1 : 0;
      const day = parts && month ? calendarDay(Number(parts[3]), month, Number(parts[1])) : null;
      if (!day) return invalid('Vasco Maritime returned a move without its time');
      const stage = vascoStage(code);
      const location = place(code, bill);
      return [{ local_time: `${day}T${parts![4]}:${parts![5]}`, description: wording, ...(location ? { location } : {}),
        provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) }];
    }).reverse() };
  });
  const asked = query.kind === 'container' ? containers.filter(({ container }) => container === query.number) : containers;
  if (query.kind === 'container' && !asked.length) throw new IndeterminateError(PROVIDER, 'Vasco Maritime left the container out of its bill');
  return asked.map(({ events }) => events);
}

type Ordered = { event: CarrierEvent; order: number };
// The newest first; moves at one minute keep the order given, which lists the later first.
const newestFirst = (left: Ordered, right: Ordered) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : left.order - right.order;

/**
 * The move whose stage the shipment is at. A bill's containers move apart: one handed over
 * does not make the others delivered, so a delivery decides only once every container has one.
 */
function currentMove(containers: readonly (readonly CarrierEvent[])[]): CarrierEvent | undefined {
  const latest = containers.map(events => events.map((event, order) => ({ event, order }))
    .filter(({ event }) => event.stage).sort(newestFirst)[0]?.event)
    .filter((event): event is CarrierEvent => event !== undefined);
  // A container without a staged move holds nothing open.
  const open = latest.filter(event => event.stage !== 'delivered');
  return (open.length ? open : latest).map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/** The shipment from its containers' moves, each container's newest first. */
export function vascoResult(containers: readonly (readonly CarrierEvent[])[]): CarrierResult {
  const seen = new Set<string>();
  const events = containers.flatMap((moves, index) => moves.map((event, row) => ({ event, order: index * MOVES.length + row })))
    .sort(newestFirst)
    // A bill's containers move together: a move they share at one minute is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Vasco Maritime lists the bill without moves', { reason: 'listed' });
  const newest = events[0]!;
  const current = currentMove(containers);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}
