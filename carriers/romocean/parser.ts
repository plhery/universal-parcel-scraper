import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { romoceanStage } from './status.js';

export const PROVIDER = 'Romocean';
// A bill's containers and their whole histories are a few kilobytes each.
export const ROMOCEAN_MAX_BYTES = 2 * 1024 * 1024;
/** The containers the adapter asks for in one page. */
export const ROMOCEAN_PAGE_SIZE = 100;

// A bill: the codes of the ports of loading and of discharge, a serial, then R.
const BILL = /^[A-Z]{6}\d{5}R$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,7})?)?$/;
// A UN/LOCODE with a space between the country and the place.
const PORT = /^([A-Z]{2}) ?([A-Z2-9]{3})$/;
const MAX_MOVES = 1000;
const MAX_EVENTS = 200;
// The consignee's collection and the empty return that follow a bill's discharge can come without a bill.
const CLOSING = new Set(['T/C', 'MTY']);

/** A bill of lading in the tracker's form. */
export function romoceanBill(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.-]/g, '') : '';
  if (!BILL.test(number)) throw new InvalidInputError(PROVIDER, 'Romocean tracks a bill of lading');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The bill's containers, each with its moves for the bill, and whether the tracker left containers out. */
export interface RomoceanBill {
  readonly containers: readonly (readonly CarrierEvent[])[];
  readonly truncated: boolean;
}

type Move = { bill: string; code: string; event: CarrierEvent };

/** A container's whole history, the oldest first. The tracker lists the newest first. */
function history(row: unknown): Move[] {
  if (!isRecord(row) || !Array.isArray(row.ContainerMovementList)) return invalid('Romocean returned a container without its moves');
  const listed = row.ContainerMovementList;
  if (listed.length > MAX_MOVES) return invalid('Romocean returned too many moves');
  return listed.map((move, order) => {
    if (!isRecord(move)) return invalid('Romocean returned an invalid move');
    const time = TIME.exec(text(move.MovementDate, 40));
    const day = time ? calendarDay(Number(time[1]), Number(time[2]), Number(time[3])) : null;
    const code = text(move.ContainerMovementCode, 12).toUpperCase();
    if (!day || !code) return invalid('Romocean returned a move without its time or code');
    // The wording repeats the code before a dash.
    const listedWording = text(move.ContainerMovement, 200);
    const wording = listedWording.toUpperCase().startsWith(`${code}-`) ? listedWording.slice(code.length + 1).trim() : listedWording;
    const port = PORT.exec(text(move.PortDescription, 20).toUpperCase());
    const stage = romoceanStage(code);
    const event: CarrierEvent = { local_time: `${day}T${time![4]}:${time![5]}`, description: wording || code,
      ...(port ? { location: `${port[1]}${port[2]}` } : {}), provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { order, move: { bill: text(move.BlCode, 30).toUpperCase(), code, event } };
  })
    // Moves at one minute keep the order given, which lists the later first.
    .sort((left, right) => left.move.event.local_time! < right.move.event.local_time! ? -1
      : left.move.event.local_time! > right.move.event.local_time! ? 1 : right.order - left.order)
    .map(({ move }) => move);
}

/**
 * The moves a container made for the bill, the newest first. Its history holds its other bills too:
 * the bill's moves run from the first that names it to the last, with whatever the tracker filed
 * between them under another bill, then the collection and empty return that follow without one.
 */
function billMoves(moves: readonly Move[], bill: string): CarrierEvent[] {
  const first = moves.findIndex(move => move.bill === bill);
  if (first < 0) return [];
  let last = moves.length - 1 - [...moves].reverse().findIndex(move => move.bill === bill);
  while (moves[last]!.code !== 'MTY' && moves[last + 1] && !moves[last + 1]!.bill && CLOSING.has(moves[last + 1]!.code)) last++;
  return moves.slice(first, last + 1).map(move => move.event).reverse();
}

/** The tracker's answer for a bill. A bill it does not hold comes back without containers. */
export function parseRomocean(body: string, bill: string): RomoceanBill {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return invalid('Romocean returned an unreadable reply');
  }
  const pages: unknown[] = isRecord(reply) && Array.isArray(reply.Data) ? reply.Data : [];
  const [page] = pages;
  if (!isRecord(page) || !Array.isArray(page.Data)) return invalid('Romocean returned an invalid reply');
  if (!page.Data.length) throw new NotFoundError(PROVIDER, 'Romocean has no bill of lading for this number');
  if (page.Data.length > ROMOCEAN_PAGE_SIZE) return invalid('Romocean returned too many containers');
  const total = isRecord(page.PaginationInfo) ? page.PaginationInfo.CountTotal : undefined;
  return { containers: page.Data.map(row => billMoves(history(row), bill)),
    truncated: typeof total === 'number' && total > page.Data.length };
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

/** The shipment from its containers' moves for the bill, each container's newest first. */
export function romoceanResult({ containers, truncated }: RomoceanBill): CarrierResult {
  const seen = new Set<string>();
  const events = containers.flatMap((moves, index) => moves.map((event, row) => ({ event, order: index * MAX_MOVES + row })))
    .sort(newestFirst)
    // A bill's containers sail together: a move they share at one minute and port is kept once.
    .filter(({ event }) => {
      const key = JSON.stringify([event.local_time, event.provider_code, event.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    })
    .map(({ event }) => event);
  // The bill names containers whose histories hold no move for it yet.
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Romocean lists the bill without its moves', { reason: 'listed' });
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
