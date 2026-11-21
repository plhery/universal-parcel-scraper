import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, PlannedEvent } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { sarjakStage } from './status.js';

export const PROVIDER = 'Sarjak Container Lines';
// A booking's page is tens of kilobytes, with a panel for each container.
export const SARJAK_MAX_BYTES = 2 * 1024 * 1024;

/** What iTrack looks up: a container by its ISO 6346 number, a bill of lading or a booking. */
export interface SarjakQuery {
  readonly kind: 'container' | 'bill' | 'booking';
  /** The number as iTrack names it: a booking with its ports apart, as `NSA-SOH-158685`. */
  readonly number: string;
}

/** A container's milestones as iTrack lists them: the ones done, the newest first, and the ones ahead. */
export interface SarjakContainer {
  readonly number: string;
  readonly events: readonly CarrierEvent[];
  readonly planned: readonly PlannedEvent[];
}

const CONTAINER = /^[A-Z]{3}[UJZ]\d{7}$/;
// A bill: the ports of loading and discharge, then a serial whose last digits are the booking's.
const BILL = /^[A-Z]{6}\d{10,12}$/;
// A booking: the ports of loading and discharge, then its serial.
const BOOKING = /^([A-Z]{3})[/-]?([A-Z]{3})[/-]?(\d{5,7})$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DATE = /^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})$/;
const NOT_FOUND = /Tracking reference number is incorrect/;
const ITEM = /<div class="accordion-item\b/g;
const SLIDE = /<div class="swiper-slide">([\s\S]*?)<small class='([^']{0,40})'>/g;
// The page's marks for a milestone: done on time, late or off plan, or still ahead.
const DONE = new Set(['ontime', 'late', 'exception']);
const AHEAD = new Set(['forecast', 'notupdated']);
const MAX_CONTAINERS = 200;
const MAX_MILESTONES = 50;
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

/** The lookup for a number: a container with its check digit, a Sarjak bill or a booking. */
export function sarjakQuery(raw: string): SarjakQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.]/g, '') : '';
  const plain = number.replace(/-/g, '');
  if (CONTAINER.test(plain)) {
    if (containerCheckDigit(plain.slice(0, 10)) !== Number(plain[10])) {
      throw new InvalidInputError(PROVIDER, 'The container number\'s check digit does not match');
    }
    return { kind: 'container', number: plain };
  }
  if (BILL.test(plain)) return { kind: 'bill', number: plain };
  const booking = BOOKING.exec(number);
  // The page sends a booking's slashes as hyphens; without them iTrack does not know it.
  if (booking) return { kind: 'booking', number: `${booking[1]}-${booking[2]}-${booking[3]}` };
  throw new InvalidInputError(PROVIDER, 'Sarjak tracks a container number, a bill of lading or a booking');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A value of the booking's summary, by its heading. */
const summary = (html: string, heading: string) =>
  textFromHtml(new RegExp(`<h5>${heading}</h5>\\s*<p>([^<]*)</p>`).exec(html)?.[1] ?? '', 60);

/** A milestone's day, as `2026-09-22`. */
function day(value: string): string {
  const parts = DATE.exec(value);
  const month = parts ? MONTHS.indexOf(parts[2]!.toUpperCase()) + 1 : 0;
  return (parts && month ? calendarDay(Number(parts[3]), month, Number(parts[1])) : null) ?? invalid('Sarjak returned an invalid milestone date');
}

/** A container's milestones from its panel. */
function container(item: string): SarjakContainer {
  const number = /<h4>\s*([A-Z0-9]{1,20}) - [^<]*<span class="stops">/.exec(item)?.[1] ?? '';
  if (!CONTAINER.test(number)) return invalid('Sarjak returned a container without its number');
  const slides = [...item.matchAll(SLIDE)];
  if (slides.length > MAX_MILESTONES) return invalid('Sarjak returned too many milestones');
  const events: CarrierEvent[] = [];
  const planned: PlannedEvent[] = [];
  for (const [, slide, mark] of slides) {
    const description = textFromHtml(/<div class="timestamp">\s*<p>([^<]*)<\/p>/.exec(slide!)?.[1] ?? '', 120);
    const date = textFromHtml(/<h5>([\s\S]*?)<\/h5>/.exec(slide!)?.[1] ?? '', 40);
    // The milestone's place; a sailing's next port sits in a tooltip before it.
    const places = [...(/<div class="status">([\s\S]*)<\/div>/.exec(slide!)?.[1] ?? '').matchAll(/<h4\b[^>]*>([^<]*)<\/h4>/g)];
    const location = textFromHtml(places.at(-1)?.[1] ?? '', 120);
    const state = mark!.toLowerCase().replace(/[\s_-]/g, '');
    if (!description) return invalid('Sarjak returned a milestone without its name');
    if (!DONE.has(state) && !AHEAD.has(state)) return invalid('Sarjak marked a milestone in an unknown way');
    // A milestone the page lists without a day has not happened and has no plan.
    if (!date) continue;
    const stage = sarjakStage(description);
    const step = { local_time: day(date), description, ...(location ? { location } : {}) };
    if (DONE.has(state)) events.push({ ...step, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
    else planned.push({ ...step, ...(stage ? { stage } : {}) });
  }
  // The panel lists the earliest first.
  return { number, events: events.reverse(), planned };
}

/**
 * The containers iTrack lists for the number asked: every container of a booking or bill, or the
 * container itself. A reply that says the reference is incorrect is its not-found answer.
 */
export function parseSarjakTracking(html: string, query: SarjakQuery): SarjakContainer[] {
  // The page keeps an older forecast table in a comment.
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  if (!/class="tracking_form_details"/.test(page)) {
    if (NOT_FOUND.test(page)) throw new NotFoundError(PROVIDER, 'Sarjak has no booking or container for this number');
    return invalid('Sarjak returned a tracking page without a booking');
  }
  const booking = summary(page, 'Booking No\\.').replace(/\//g, '-');
  const bill = summary(page, 'BL No\\.');
  if (!booking) return invalid('Sarjak returned a booking without its number');
  const starts = [...page.matchAll(ITEM)].map(match => match.index);
  if (starts.length > MAX_CONTAINERS) return invalid('Sarjak returned too many containers');
  const listed = starts.map((start, index) => container(page.slice(start, starts[index + 1] ?? page.length)));
  if (query.kind === 'container') {
    const asked = listed.filter(item => item.number === query.number);
    if (!asked.length) throw new IndeterminateError(PROVIDER, 'Sarjak answered for another container');
    return asked;
  }
  if ((query.kind === 'bill' ? bill : booking) !== query.number) throw new IndeterminateError(PROVIDER, `Sarjak answered for another ${query.kind}`);
  return listed;
}

type Ordered = { event: CarrierEvent; order: number };
// The newest first; milestones on one day keep the order given, which lists the later first.
const newestFirst = (left: Ordered, right: Ordered) =>
  left.event.local_time! < right.event.local_time! ? 1 : left.event.local_time! > right.event.local_time! ? -1 : left.order - right.order;

/**
 * The milestone whose stage the shipment is at. A booking's containers move apart: one returned
 * empty does not make the others delivered, so a delivery decides only once every container has one.
 */
function currentMilestone(containers: readonly SarjakContainer[]): CarrierEvent | undefined {
  const latest = containers.map(item => item.events.map((event, order) => ({ event, order }))
    .filter(({ event }) => event.stage).sort(newestFirst)[0]?.event);
  const open = latest.filter(event => event?.stage !== 'delivered');
  const candidates = (open.length ? open : latest).filter((event): event is CarrierEvent => event !== undefined);
  return candidates.map((event, order) => ({ event, order })).sort(newestFirst)[0]?.event;
}

/** The shipment from its containers' milestones, the newest first, with the ones still ahead. */
export function sarjakResult(containers: readonly SarjakContainer[]): CarrierResult {
  // A booking's containers share their vessel's milestones: each is kept once.
  const once = () => {
    const seen = new Set<string>();
    return (step: CarrierEvent | PlannedEvent) => {
      const key = JSON.stringify([step.local_time, step.description, step.location ?? '']);
      return !seen.has(key) && Boolean(seen.add(key));
    };
  };
  const events = containers.flatMap((item, index) => item.events.map((event, row) => ({ event, order: index * MAX_MILESTONES + row })))
    .sort(newestFirst).map(({ event }) => event).filter(once());
  const planned = containers.flatMap(item => item.planned).filter(once());
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Sarjak lists the booking without a milestone done', { reason: 'listed' });
  const newest = events[0]!;
  const current = currentMilestone(containers);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
    ...(planned.length ? { planned_events: planned } : {}),
  };
}
