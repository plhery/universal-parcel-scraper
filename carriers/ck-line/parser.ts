import { InvalidInputError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { ckLineStage } from './status.js';

export const PROVIDER = 'CK Line';
// A booking's container list and a container's moves are each a few kilobytes.
export const CK_LINE_MAX_BYTES = 1024 * 1024;

/** What the e-service looks up: a bill of lading or a booking. */
export interface CkLineQuery {
  readonly kind: 'bill' | 'booking';
  /** The number as the e-service names it, a bill with its `CKCO` prefix. */
  readonly number: string;
  /** The number the search takes: a bill without its prefix. */
  readonly search: string;
}

/** A container the e-service lists for the number, with the bill its moves are kept under. */
export interface CkLineContainer {
  readonly number: string;
  readonly bill: string;
  readonly booking: string;
}

// A bill: CK Line's SCAC, the port of loading, then a serial.
const BILL = /^(?:CKCO)?([A-Z]{3}\d{6,8})$/;
// A booking: two letters of the office, then a serial.
const BOOKING = /^[A-Z]{2}\d{6,8}$/;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
// The codes of an empty container's return; the page counts one only when it belongs to the import.
const RETURNS = new Set(['TE', 'TD']);
const MAX_CONTAINERS = 200;
const MAX_MOVES = 300;
const MAX_EVENTS = 200;

/** The lookup for a number: a CK Line bill, with or without its prefix, or a booking. */
export function ckLineQuery(raw: string): CkLineQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.-]/g, '') : '';
  const bill = BILL.exec(number);
  if (bill) return { kind: 'bill', number: `CKCO${bill[1]}`, search: bill[1]! };
  if (BOOKING.test(number)) return { kind: 'booking', number, search: number };
  throw new InvalidInputError(PROVIDER, 'CK Line tracks a bill of lading or a booking');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The rows of an e-service reply, which wraps them with its result code. */
function rows(reply: unknown, what: string): Record<string, unknown>[] {
  if (!isRecord(reply) || !isRecord(reply.resMeta)) return invalid(`CK Line returned an invalid ${what}`);
  if (reply.resMeta.resultCd !== 'S') throw new TransportError(PROVIDER, `CK Line could not answer its ${what}`);
  if (!Array.isArray(reply.resData) || !reply.resData.every(isRecord)) return invalid(`CK Line returned an invalid ${what}`);
  return reply.resData;
}

/** The containers the e-service lists for the bill or booking asked. An empty list is its not-found answer. */
export function parseCkLineContainers(reply: unknown, query: CkLineQuery): CkLineContainer[] {
  const listed = rows(reply, 'container list');
  if (!listed.length) throw new NotFoundError(PROVIDER, 'CK Line has no bill or booking for this number');
  if (listed.length > MAX_CONTAINERS) return invalid('CK Line returned too many containers');
  const containers = new Map<string, CkLineContainer>();
  for (const row of listed) {
    const item = { number: text(row.KCTCNO, 20), bill: text(row.FRTBNO, 30), booking: text(row.BINBKN, 30) };
    if (!CONTAINER.test(item.number) || !item.bill || !item.booking) return invalid('CK Line returned a container without its numbers');
    if ((query.kind === 'bill' ? item.bill : item.booking) !== query.number) throw new IndeterminateError(PROVIDER, `CK Line answered for another ${query.kind}`);
    if (!containers.has(item.number)) containers.set(item.number, item);
  }
  return [...containers.values()];
}

/** A container's moves, the newest first, on the ports' wall clocks. */
export function parseCkLineMoves(reply: unknown, container: CkLineContainer): CarrierEvent[] {
  const moves = rows(reply, 'container moves');
  if (moves.length > MAX_MOVES) return invalid('CK Line returned too many moves');
  return moves.map((row): CarrierEvent => {
    if (text(row.CMVENO, 20) !== container.number || text(row.BINBKN, 30) !== container.booking) {
      throw new IndeterminateError(PROVIDER, 'CK Line answered for another container');
    }
    const description = text(row.CMVSTA, 200);
    const code = text(row.CMVSTACD, 10);
    const parts = TIME.exec(text(row.CMVDTM, 20));
    const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
    if (!description || !day) return invalid('CK Line returned a move without its description or time');
    // An empty return the page does not count for the import keeps no code, so no stage.
    const counted = code && (!RETURNS.has(code) || row.IMPCHK === 'Y');
    const stage = counted ? ckLineStage(code) : undefined;
    const location = text(row.CDPCMN, 120);
    return { local_time: `${day}T${parts![4]}:${parts![5]}`, description, ...(location ? { location } : {}),
      ...(counted ? { provider_code: code } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).reverse();
}

type Ordered = { event: CarrierEvent; order: number };
// The newest first; moves at one minute keep the order given, which lists the later first.
const newestFirst = (left: Ordered, right: Ordered) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : left.order - right.order;

/**
 * The move whose stage the shipment is at. A booking's containers move apart: one returned
 * empty does not make the others delivered, so a delivery decides only once every container has one.
 */
function currentMove(containers: readonly (readonly CarrierEvent[])[]): CarrierEvent | undefined {
  const latest = containers.map(events => events.map((event, order) => ({ event, order }))
    .filter(({ event }) => event.stage).sort(newestFirst)[0]?.event);
  const known = latest.filter((event): event is CarrierEvent => event !== undefined);
  // A container without a staged move holds nothing open.
  const open = known.filter(event => event.stage !== 'delivered');
  const candidates = open.length ? open : known;
  return candidates.map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/** The shipment from its containers' moves, each container's newest first. */
export function ckLineResult(containers: readonly (readonly CarrierEvent[])[], truncated = false): CarrierResult {
  const seen = new Set<string>();
  const events = containers.flatMap((moves, index) => moves.map((event, row) => ({ event, order: index * MAX_MOVES + row })))
    .sort(newestFirst)
    // A booking's containers share their vessel's moves: each is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'CK Line lists the containers without moves', { reason: 'listed' });
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
