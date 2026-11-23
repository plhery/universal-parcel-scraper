import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { pashaSide, pashaStage } from './status.js';

export const PROVIDER = 'Pasha Hawaii';
/** The tracker pashahawaii.com's track and trace page frames, which its form posts to. */
export const PASHA_TRACKER = 'https://web01.pashahawaii.com/PHLiner/Tracking';
export const PASHA_MAX_BYTES = 1_000_000;
/** The containers of a bill or booking whose own moves are asked. */
export const MAX_DETAILS = 3;

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
const BOOKING = /^\d{10}$/;
const BILL = /^\d{12}$/;
const MAX_ROWS = 500;

/** What Pasha Hawaii tracks: a booking, a bill of lading, or a container by its ISO 6346 number. */
export type PashaQuery = { kind: 'booking' | 'bill' | 'container'; number: string };

// The form's search types, the inquiry each answers with and the header field naming its number.
const SEARCH_TYPES = { booking: '0', bill: '1', container: '2' } as const;
const INQUIRIES = { booking: 'Booking Inquiry', bill: 'B/L Inquiry', container: 'Container Inquiry' } as const;
const NUMBER_FIELDS = { booking: 'Booking', bill: 'B/L Number', container: 'Container Number' } as const;

// Letters count from 10 and skip the multiples of 11: A is 10, B 12, L 23, Z 38.
const LETTER_VALUES = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter, index) => [letter, 10 + index + Math.floor((index + 9) / 10)]));

/** The ISO 6346 check digit of a container's owner code, category and serial number. */
export function containerCheckDigit(body: string): number {
  if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(body)) throw new InvalidInputError(PROVIDER, 'Container numbers are an owner code, a category letter and six digits');
  const sum = [...body].reduce((total, character, index) => total + (LETTER_VALUES.get(character) ?? Number(character)) * 2 ** index, 0);
  return sum % 11 % 10;
}

/** A whole container number with its check digit, a booking of ten digits or a bill of twelve. */
export function pashaQuery(raw: string): PashaQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (CONTAINER.test(number)) {
    if (containerCheckDigit(number.slice(0, 10)) !== Number(number[10])) throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    return { kind: 'container', number };
  }
  if (BOOKING.test(number)) return { kind: 'booking', number };
  if (BILL.test(number)) return { kind: 'bill', number };
  throw new InvalidInputError(PROVIDER, 'Pasha Hawaii tracks a booking of ten digits, a bill of lading of twelve or a container number');
}

/** The tracker's form for a search, as its page posts it. */
export function pashaSearchForm(query: PashaQuery): URLSearchParams {
  return new URLSearchParams([['SearchType', SEARCH_TYPES[query.kind]], ['SearchTerm', query.number]]);
}

// Bot checks a CDN or firewall could put in place of the tracker's page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|_Incapsula_Resource|captcha/i;
const text = ($: CheerioAPI, element: AnyNode | Cheerio<AnyNode>, max = 300) => clean($(element).text(), max);

/** A reply's page and its header's fields, once it answers the search asked; null when the number is not on file. */
function inquiry(html: string, query: PashaQuery): { $: CheerioAPI; fields: ReadonlyMap<string, string> } | null {
  if (CHALLENGE.test(html.slice(0, 100_000))) throw new ChallengeError(PROVIDER, 'Pasha Hawaii\'s tracker answered with a browser check');
  const $ = load(html);
  const form = $('form[action="/PHLiner/Tracking"]');
  const type = form.find('select#SearchType option[selected]').attr('value');
  const term = form.find('input#SearchTerm').attr('value');
  if (form.length !== 1 || type === undefined || term === undefined) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a page without its tracking form');
  if (type !== SEARCH_TYPES[query.kind] || clean(term, 64) !== query.number) throw new SchemaError(PROVIDER, 'Pasha Hawaii answered another search');
  const headings = $('h4').toArray().map(heading => text($, heading, 100));
  if ($('h5').toArray().some(heading => text($, heading) === `${query.number} is not on file, please try again.`)) {
    if (headings.length) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned an inquiry for a number not on file');
    return null;
  }
  if (headings[0] !== INQUIRIES[query.kind]) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned another inquiry');
  const fields = new Map<string, string>();
  $('dl.dl-horizontal > dt').each((_, term) => {
    fields.set(text($, term, 100).replace(/\*$/, ''), text($, $(term).next('dd')));
  });
  if (fields.get(NUMBER_FIELDS[query.kind]) !== query.number) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned another number');
  return { $, fields };
}

/** A table's column names, without the colon its narrow layout shows. */
function columns($: CheerioAPI, table: Cheerio<Element>): string[] {
  return table.find('thead th').toArray().map(cell => text($, cell, 100).replace(/:$/, ''));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DATE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?: ([01]\d|2[0-3]):([0-5]\d))?$/;
const pad = (value: number) => String(value).padStart(2, '0');

/** A date as the tracker writes it, "Nov 21, 2026 01:51", as a wall clock, or the day alone. */
function wallClock(date: string, timed: boolean): string {
  const parts = DATE.exec(date);
  const month = MONTHS.indexOf(parts?.[1] ?? '') + 1;
  const day = parts ? `${parts[3]}-${pad(month)}-${pad(Number(parts[2]))}` : '';
  const local = parts && parts[4] ? `${day}T${parts[4]}:${parts[5]}:00` : day;
  if (!parts || !month || Boolean(parts[4]) !== timed || day < '2001' || !isoTime(local, 'UTC')) {
    throw new SchemaError(PROVIDER, 'Pasha Hawaii returned an invalid move date');
  }
  return local;
}

// The places of Pasha Hawaii's moves: a town and its state, as "HONOLULU, HI" or "OAKLAND,CA", or
// a terminal or yard named by its port's town or code, as "LONG BEACH SSAPIER A" or
// "YOUNG BROTHERS HIL".
const STATE = /,\s*([A-Z]{2})$/;
const STATES = new Set(['CA', 'HI', 'WA']);
const PORT_ZONES: readonly [RegExp, string][] = [
  [/\b(?:HONOLULU|HNL|HILO|HIL|KAHULUI|KAWAIHAE|NAWILIWILI)\b/, 'Pacific/Honolulu'],
  [/\b(?:LONG ?BEACH|LOS ANGELES|OAKLAND|SAN DIEGO|TACOMA|SEATTLE)\b/, 'America/Los_Angeles'],
];

/** The zone of a place, or null for one the tracker does not name by a town or port Pasha Hawaii serves. */
function placeZone(place: string): string | null {
  const state = STATE.exec(place)?.[1];
  if (state) return STATES.has(state) ? usStateTimeZone(state) : null;
  return PORT_ZONES.find(([pattern]) => pattern.test(place))?.[1] ?? null;
}

/** A move's clock, read on its place's zone when the place has one. */
function stamp(local: string, location: string | undefined, zone: string | null) {
  const instant = zone && local.includes('T') ? isoTime(local, zone) : null;
  return {
    ...(instant ? { time: instant.iso } : {}), local_time: local, ...(instant ? { time_zone: zone!, time_zone_basis: 'place' } : {}),
    ...(location ? { location } : {}),
  };
}

/** A move of a container as its table lists it, with the booking or bill it carries. */
export type PashaMove = CarrierEvent & { local_time: string; description: string; booking: string | null; bill: string | null };

/**
 * A move from its row. It takes place where the container leaves or where it arrives, by its
 * wording; a wording the tracker has not shown is placed only where both ends agree.
 */
function move(cells: readonly string[]): PashaMove {
  const [date, from, to, description, booking, bill] = cells as [string, string, string, string, string, string];
  if (!description) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a move without its status');
  const side = pashaSide(description);
  let location: string | undefined;
  let zone: string | null;
  if (side) {
    location = (side === 'from' ? from || to : to || from) || undefined;
    zone = location ? placeZone(location) : null;
  } else {
    location = from === to || !to ? from || undefined : !from ? to : undefined;
    const zones = [from, to].filter(Boolean).map(placeZone);
    zone = zones.length && zones.every(value => value && value === zones[0]) ? zones[0]! : null;
  }
  return {
    ...stamp(wallClock(date, true), location, zone), description,
    booking: BOOKING.test(booking) ? booking : null, bill: BILL.test(bill) ? bill : null,
  };
}

const MOVE_COLUMNS = ['Date', 'Moved From', 'Moved To', 'Status', 'Booking', 'B/L', 'Vessel/Voyage'];

/**
 * A container's moves, newest first as the tracker lists them, from its container inquiry, or null
 * when the container is not on file. The table goes back some months, over several cycles.
 */
export function pashaContainer(html: string, container: string): PashaMove[] | null {
  const reply = inquiry(html, { kind: 'container', number: container });
  if (!reply) return null;
  const { $ } = reply;
  const table = $('table#MoveDetails');
  if (table.length !== 1 || columns($, table).join('|') !== MOVE_COLUMNS.join('|') || table.find('tbody#MoveDetailsBody').length !== 1) {
    throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a table of moves of another layout');
  }
  const rows = table.find('tbody#MoveDetailsBody').children().toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned too many moves');
  return rows.map(row => {
    const cells = $(row).children('td').toArray().map(cell => text($, cell));
    if (!$(row).is('tr.MoveDetailsRow') || cells.length !== MOVE_COLUMNS.length) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a move of another layout');
    return move(cells);
  });
}

/** A container of a bill or booking, and the move its row shows for a bill. */
export type PashaContainerRow = { number: string; latest: PashaMove | null };

/** A bill or booking: the booking a bill names, and its containers. */
export type PashaShipment = { query: PashaQuery; booking: string | null; containers: PashaContainerRow[] };

const ROW_COLUMNS = {
  bill: ['Item', 'Container', 'Size/Type', 'Qty', 'Metric Tons', 'Cubic Meters', 'Date', 'Status', 'Location', 'Yard Location', 'Hold Status', 'Last Free Date'],
  booking: ['Item No.', 'Container No.', 'Size/Type', 'Date', 'Status', 'Location', 'Yard Location', 'Hold Status', 'Last Free Date'],
} as const;
const NO_CONTAINERS = /^There are no containers associated with this [A-Za-z/ ]{1,20}$/;

/**
 * A bill's or booking's inquiry: its containers, each once. A bill's row shows the latest move
 * under the bill, dated by its day; a booking's shows the container's latest move whatever it
 * travels under, so it is not read. Null when the number is not on file.
 */
export function pashaShipment(html: string, query: PashaQuery): PashaShipment | null {
  if (query.kind === 'container') throw new TypeError('A container has no shipment inquiry');
  const reply = inquiry(html, query);
  if (!reply) return null;
  const { $, fields } = reply;
  const booking = query.kind === 'booking' ? query.number : fields.get('Booking Number') ?? '';
  if (booking && !BOOKING.test(booking)) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a bill with an invalid booking');
  const table = $('table#ItemContainerDetails');
  if (!table.length) {
    if (!$('p').toArray().some(paragraph => NO_CONTAINERS.test(text($, paragraph, 100)))) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned an inquiry without its containers');
    return { query, booking: booking || null, containers: [] };
  }
  const expected = ROW_COLUMNS[query.kind];
  if (table.length !== 1 || columns($, table).join('|') !== expected.join('|')) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a table of containers of another layout');
  const containers = new Map<string, PashaContainerRow>();
  const rows = table.find('tbody#ItemContainerDetailsBody').children().toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned too many containers');
  for (const row of rows) {
    const cells = $(row).children('td').toArray().map(cell => text($, cell));
    if (!$(row).is('tr.ItemContainerDetailsRow') || cells.length !== expected.length) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned a container of another layout');
    const [number, date, description, location] = query.kind === 'bill' ? [cells[1]!, cells[6]!, cells[7]!, cells[8]!] : [cells[1]!, '', '', ''];
    if (!/^[A-Z]{4}\d{7}$/.test(number)) throw new SchemaError(PROVIDER, 'Pasha Hawaii returned an invalid container number');
    if (containers.has(number)) continue;
    const latest = description && date ? {
      ...stamp(wallClock(date, false), location || undefined, null), description, booking: null, bill: query.number,
    } : null;
    containers.set(number, { number, latest });
  }
  return { query, booking: booking || null, containers: [...containers.values()] };
}

/**
 * A container's moves, oldest first, cut into its cycles. A cycle starts when the empty container
 * leaves for a shipper, at a move under another booking or bill, at a booking's move once the
 * container arrived, and at a move without its bill once the empty container is back. Empty
 * moves before any of the shipment's are their own cycle.
 */
function cycles(oldestFirst: readonly PashaMove[]): PashaMove[][] {
  const all: PashaMove[][] = [];
  let current: PashaMove[] = [];
  let booking: string | null = null;
  let bill: string | null = null;
  let shipped = false;
  let arrived = false;
  let returned = false;
  for (const entry of oldestFirst) {
    const stage = pashaStage(entry.description);
    const starts = current.length > 0 && (stage === 'registered'
      || entry.booking !== null && (arrived || !shipped || booking !== null && entry.booking !== booking)
      || stage === 'accepted' && !shipped
      || entry.bill !== null && bill !== null && entry.bill !== bill
      || returned && entry.bill === null);
    if (starts) {
      all.push(current);
      current = [];
      booking = bill = null;
      shipped = arrived = returned = false;
    }
    current.push(entry);
    booking ??= entry.booking;
    bill ??= entry.bill;
    shipped ||= stage !== undefined || entry.booking !== null || entry.bill !== null;
    arrived ||= entry.bill !== null || stage === 'out_for_delivery' || stage === 'delivered';
    returned ||= stage === 'delivered';
  }
  if (current.length) all.push(current);
  return all;
}

/**
 * The stage of each move of a cycle, oldest first. The empty container returned is the delivery
 * once it left full or under its bill; returned before, it was not used.
 */
function staged(cycle: readonly PashaMove[]): CarrierEvent[] {
  let left = false;
  return cycle.map(entry => {
    let stage = pashaStage(entry.description);
    if (stage === 'out_for_delivery') left = true;
    if (stage === 'delivered' && !left && entry.bill === null) stage = undefined;
    const event: CarrierEvent = { ...entry, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    delete event.booking;
    delete event.bill;
    return event;
  });
}

const isShipment = (cycle: readonly PashaMove[]) => cycle.some(entry => entry.booking !== null || entry.bill !== null || pashaStage(entry.description));
/** The latest of the cycles that passes `test`. */
const lastOf = (all: readonly PashaMove[][], test: (cycle: readonly PashaMove[]) => boolean) => [...all].reverse().find(test);

/** A cycle's moves, newest first and staged. */
const history = (cycle: readonly PashaMove[]) => staged(cycle).reverse();

/** The stage of one history: its newest staged move's. */
const latestStage = (events: readonly CarrierEvent[]) => events.find(event => event.stage)?.stage as Stage | undefined;

function result(events: readonly CarrierEvent[], stage: Stage | undefined, truncated: boolean): CarrierResult {
  const newest = events[0]!;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: newest.time ?? null, ...(newest.time ? {} : { last_update_local: newest.local_time }),
    expected_delivery: null, ...(truncated ? { history_truncated: true } : {}), events: [...events],
  };
}

/**
 * A container's latest cycle, staged: the moves from its latest shipment on, without the empty
 * container's repositioning once it is back. A container without moves is listed without history.
 */
export function pashaContainerResult(moves: readonly PashaMove[]): CarrierResult {
  if (!moves.length) throw new NoHistoryError(PROVIDER, 'Pasha Hawaii lists the container without moves', { reason: 'listed' });
  const all = cycles([...moves].reverse());
  const latest = lastOf(all, isShipment) ?? all.at(-1)!;
  const events = history(latest);
  return result(events, latestStage(events), false);
}

/**
 * The stage a shipment is at. Its containers move apart: one returned empty does not make the
 * others delivered, so a delivery decides only once every container has one, and a container
 * without a staged move leaves the stage open.
 */
function shipmentStage(histories: readonly CarrierEvent[][]): Stage | undefined {
  const latest = histories.map(events => events.find(event => event.stage)).filter((event): event is CarrierEvent => event !== undefined);
  const open = latest.filter(event => event.stage !== 'delivered').sort(newestFirst)[0];
  if (open) return open.stage as Stage;
  return latest.length && latest.length === histories.length ? 'delivered' : undefined;
}

const newestFirst = (left: CarrierEvent, right: CarrierEvent) => (right.local_time ?? '').localeCompare(left.local_time ?? '');

/**
 * A bill or booking from its containers: for each container asked, its cycle under the bill or
 * booking; for a bill's other containers, and those whose table no longer holds the cycle, the
 * move the bill's row shows. Merged newest first.
 */
export function pashaShipmentResult(shipment: PashaShipment, details: ReadonlyMap<string, readonly PashaMove[] | null>): CarrierResult {
  const { query, booking } = shipment;
  const bill = query.kind === 'bill' ? query.number : null;
  const ours = (entry: PashaMove) => entry.booking !== null && entry.booking === booking || entry.bill !== null && entry.bill === bill;
  const truncated = shipment.containers.length > MAX_DETAILS;
  const histories = shipment.containers.map(container => {
    const moves = details.get(container.number);
    const cycle = moves ? lastOf(cycles([...moves].reverse()), candidate => candidate.some(ours)) : undefined;
    if (cycle) return history(cycle);
    return container.latest ? history([container.latest]) : [];
  });
  const events = histories.length > 1 ? histories.flat().sort(newestFirst) : histories.flat();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Pasha Hawaii lists the shipment without moves', { reason: 'listed' });
  return result(events.slice(0, MAX_ROWS), shipmentStage(histories), truncated || events.length > MAX_ROWS);
}
