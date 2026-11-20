import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryTimeZone, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { swireStage } from './status.js';

export const PROVIDER = 'Swire Shipping';
/** Swire's online portal, a Blazor Server app whose tracking page needs no account. */
export const SWIRE_APP = 'https://online.swireshipping.com/';
const MAX_ROWS = 500;

// A bill is two letters for the country of its port of loading and eight digits; US import
// records put PLLU, the SCAC they file Swire's Pacific Islands bills under, before it.
const BILL = /^(?:PLLU)?([A-Z]{2}\d{8})$/;
const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;

/** What Swire's page tracks for a guest: a bill of lading or a container. */
export type SwireQuery = { kind: 'bl' | 'container'; number: string };

export function swireQuery(raw: string): SwireQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) return { kind: 'container', number };
  const bill = BILL.exec(number)?.[1];
  if (bill) return { kind: 'bl', number: bill };
  throw new InvalidInputError(PROVIDER, 'Swire Shipping tracks a bill of lading of two letters and eight digits or a container number');
}

/** The tracking page for a number, which looks it up as it opens. */
export function swirePageUrl({ kind, number }: SwireQuery): string {
  return `${SWIRE_APP}tracking?${new URLSearchParams({ type: kind, query: number })}`;
}

const NOT_FOUND = /^We are unable to find details for (\S+) (?:Bill of Lading|Container|Booking) Number\.?$/;

/** Whether the page says it holds no such number; the sentence for another number is not this lookup's. */
function notFound($: CheerioAPI, query: SwireQuery): boolean {
  for (const element of $('.alert strong').get()) {
    const match = NOT_FOUND.exec(clean($(element).text(), 300));
    if (!match) continue;
    if (match[1] !== query.number) throw new IndeterminateError(PROVIDER, 'Swire Shipping answered for another lookup');
    return true;
  }
  return false;
}

/** Whether the page rendered so far answers the lookup, and how. */
export function swirePageState(html: string, query: SwireQuery): 'pending' | 'not_found' | 'shipment' {
  const $ = load(html);
  // Telerik's loader covers the page until its lookup has answered.
  if ($('.k-loader-container').length) return 'pending';
  if (notFound($, query)) return 'not_found';
  return $('.booking-card-grid, .container-card-grid').length ? 'shipment' : 'pending';
}

/** A card's fields by their titles: each value's title, which holds it whole, or its text. */
function fields($: CheerioAPI, card: Cheerio<Element>): Map<string, string> {
  const found = new Map<string, string>();
  for (const pair of card.find('.datapair-container').get()) {
    const value = $(pair).find('.datapair-value').first();
    const text = clean(value.attr('title') ?? value.text(), 300);
    // The page writes a dash for a field it has no value for.
    found.set(clean($(pair).find('.datapair-title').text(), 100), text === '-' ? '' : text);
  }
  return found;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WHEN = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) (\d{1,2}):(\d{2}) ([AP]M)$/;
const pad = (value: number) => String(value).padStart(2, '0');

/** A move's wall clock from the page's day and twelve-hour clock, such as "12 Nov 2026 01:49 PM". */
function wallClock(text: string): string {
  const match = WHEN.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!) + 1 : 0;
  const hour = match ? Number(match[4]) : 0;
  const year = match ? Number(match[3]) : 0;
  const local = match && month && hour >= 1 && hour <= 12
    ? `${match[3]}-${pad(month)}-${pad(Number(match[1]))}T${pad(hour % 12 + (match[6] === 'PM' ? 12 : 0))}:${match[5]}:00` : '';
  if (!local || year < 2001 || year > 2100 || !isoTime(local, 'UTC')) throw new SchemaError(PROVIDER, 'Swire Shipping returned an invalid move time');
  return local;
}

// The page names each port with its UN/LOCODE. These ports' countries keep several zones, or
// one core does not list.
const PORT_ZONES: Readonly<Record<string, string>> = {
  ASPPG: 'Pacific/Pago_Pago', USLAX: 'America/Los_Angeles', USLGB: 'America/Los_Angeles',
};
const LOCODE = /\(([A-Z]{2})([A-Z\d]{3})\)$/;

/** A move's wall clock, and the instant it gives when its port keeps one zone. */
function stamp(local: string, port: string) {
  const code = LOCODE.exec(port);
  const zone = code ? PORT_ZONES[`${code[1]}${code[2]}`] ?? countryTimeZone(code[1]!) : null;
  const instant = zone ? isoTime(local, zone) : null;
  return instant ? { local_time: local, time: instant.iso, time_zone: zone!, time_zone_basis: 'place' } : { local_time: local };
}

type Move = CarrierEvent & { local_time: string; description: string };
/** A container's moves, and whether the page listed all of them or only its latest. */
type Container = { container: string; moves: Move[]; whole: boolean };

function move(local: string, description: string, port: string, location: string): Move {
  const stage = swireStage(description);
  return { ...stamp(local, port), ...(location ? { location } : {}), description,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
}

/** The moves the page lists under an open container, oldest first. Those it plans are not events yet. */
function timeline($: CheerioAPI, rows: Cheerio<Element>): Move[] {
  const moves: Move[] = [];
  for (const row of rows.get()) {
    const cells = $(row).children('div');
    if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Swire Shipping changed its container history');
    const when = cells.eq(0);
    const badge = clean(when.find('.custom-badge').text(), 50);
    if (!badge) throw new SchemaError(PROVIDER, 'Swire Shipping changed its container history');
    if (badge !== 'ACTUAL') continue;
    when.find('.container-tracking-event-badge').remove();
    const description = clean(cells.eq(1).find('b').first().text(), 200);
    const port = clean(cells.eq(2).find('.container-tracking-location').text(), 200);
    if (!description || !port) throw new SchemaError(PROVIDER, 'Swire Shipping returned a move without its name or port');
    const country = clean(cells.eq(2).find('.container-tracking-sub-text').text(), 100);
    const place = clean(cells.eq(3).text(), 200);
    const location = [place, port, country].filter((part) => part && part !== '-').join(', ');
    moves.push(move(wallClock(clean(when.text(), 100)), description, port, location));
  }
  return moves;
}

/**
 * The containers the page lists. It opens one, with its moves, and shows each other one's
 * latest move only.
 */
function containers($: CheerioAPI): Container[] {
  return $('.container-card-grid').get().map((grid) => {
    const card = fields($, $(grid));
    const container = card.get('Container Number & Type') ?? '';
    if (!CONTAINER.test(container)) throw new SchemaError(PROVIDER, 'Swire Shipping returned an invalid container');
    const rows = $(grid).closest('.card-body').find('.container-tracking-body');
    if (rows.length) return { container, moves: timeline($, rows), whole: true };
    const latest = card.get('Latest Event') ?? '';
    const port = card.get('Location') ?? '';
    return { container, moves: latest ? [move(wallClock(card.get('Event Date') ?? ''), latest, port, port)] : [], whole: false };
  });
}

const newestFirst = (left: Move, right: Move) => right.local_time.localeCompare(left.local_time);
// The stages of a container that has not sailed yet.
const BEFORE_SAILING: ReadonlySet<string> = new Set<Stage>(['pending', 'registered', 'accepted']);

/**
 * A container's moves newest first, staged by what came before them: a gate move after the
 * container sailed is transit; before it was discharged at its port, a full container leaving a
 * terminal is transit and an empty one returned is no delivery. Of a container shown by its
 * latest move only, a move at the bill's port of loading or place of receipt is on the way out.
 */
function containerHistory({ moves, whole }: Container, origin: ReadonlySet<string>): Move[] {
  const staged = moves.map((event) => ({ ...event }));
  let sailed = false;
  let discharged = false;
  for (const event of staged) {
    const outbound = whole ? !discharged : origin.has(event.location ?? '');
    if (outbound && (event.stage === 'out_for_delivery' || event.stage === 'delivered')) {
      if (event.stage === 'out_for_delivery') event.stage = 'in_transit';
      else {
        delete event.stage;
        delete event.stage_source;
      }
    } else if (sailed && event.stage && BEFORE_SAILING.has(event.stage)) {
      event.stage = 'in_transit';
    }
    if (event.stage === 'in_transit') sailed = true;
    if (/^import discharged/i.test(event.description)) discharged = true;
  }
  // The page lists the moves oldest first, which orders those of one minute.
  return staged.reverse().sort(newestFirst);
}

/**
 * The stage the bill is at. Its containers move apart: one returned empty does not make the
 * others delivered, so a delivery decides only once every container has one.
 */
function currentStage(histories: readonly Move[][]): Stage | undefined {
  const latest = histories.map((events) => events.find((event) => event.stage)).filter((event): event is Move => event !== undefined);
  const open = latest.filter((event) => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

/**
 * The shipment the page shows for a bill or a container: the open container's moves and each
 * other container's latest, newest first, with a move the containers share kept once.
 */
export function parseSwire(html: string, query: SwireQuery): CarrierResult {
  const $ = load(html);
  if (notFound($, query)) throw new NotFoundError(PROVIDER, 'Swire Shipping does not hold this number');
  const bills = $('.booking-card-grid');
  if (bills.length > 1 || (query.kind === 'bl') !== (bills.length === 1)) throw new SchemaError(PROVIDER, 'Swire Shipping changed its tracking page');
  const bill = bills.length ? fields($, bills) : new Map<string, string>();
  if (query.kind === 'bl' && bill.get('Bill of Lading Number') !== query.number) {
    throw new IndeterminateError(PROVIDER, 'Swire Shipping answered for another lookup');
  }
  let listed = containers($);
  if (query.kind === 'container') {
    listed = listed.filter(({ container }) => container === query.number);
    if (!listed.length) throw new IndeterminateError(PROVIDER, 'Swire Shipping answered for another lookup');
  }
  const origin = new Set([bill.get('Port of Load'), bill.get('Place of Receipt')].filter((port): port is string => Boolean(port)));
  const histories = listed.map((container) => containerHistory(container, origin));
  const count = Number(bill.get('Number of Containers') ?? listed.length);
  const truncated = listed.some(({ whole }) => !whole) || !(count <= listed.length);
  const seen = new Set<string>();
  const events = histories.flat().sort(newestFirst).filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Swire Shipping lists the shipment without moves', { reason: 'listed' });
  const newest = events[0]!;
  const stage = currentStage(histories);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: newest.time ?? null, ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null, ...(truncated || events.length > MAX_ROWS ? { history_truncated: true } : {}), events: events.slice(0, MAX_ROWS),
  };
}
