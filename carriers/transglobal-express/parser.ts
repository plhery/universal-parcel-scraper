import { InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { transglobalStage } from './status.js';

export const PROVIDER = 'transglobal-express';
// The browser service passes on the legs and rows alone: about 2 kB for thirteen rows.
export const MAX_BYTES = 256_000;
const MAX_ROWS = 500;
// "TP-10685786": the order reference on Transglobal's bookings, TP and its order number.
const REFERENCE = /^TP([1-9]\d{5,8})$/;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "Friday, October 23, 2026": the heading over a day's rows.
const DAY = new RegExp(`^(${WEEKDAYS.join('|')}), (${MONTHS.join('|')}) (\\d{1,2}), (\\d{4})$`);
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// What the page writes in its location column beside a booking or a collection: a state, not a place.
const STATE_NOTE = /^(?:awaiting [a-z -]{1,40}|in transit)$/i;
// "Evri (Main)": the partner that carries the parcel, then the leg it carries.
const LEG = /^(.{1,60}) \(([A-Za-z ]{1,30})\)$/;
// The partners whose legs the page has named, by catalog id.
const PARTNERS: Readonly<Record<string, string>> = { Evri: 'evri-uk', Spring: 'spring-gds' };
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;

/** A reference as the form takes it: TP, a hyphen and the order number. */
export function normalizeTransglobalReference(raw: string): string {
  const text = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s-]+/g, '') : '';
  const order = REFERENCE.exec(text)?.[1];
  if (!order) throw new InvalidInputError(PROVIDER, 'Enter a Transglobal Express TP- order reference');
  return `TP-${order}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) return invalid('Transglobal Express returned an unreadable row');
  return value.replace(/\s+/g, ' ').trim();
};

type Row = CarrierEvent & { local_time: string; description: string };

function day(value: unknown): string {
  const match = DAY.exec(text(value, 40));
  const date = match ? calendarDay(Number(match[4]), MONTHS.indexOf(match[2]!) + 1, Number(match[3])) : null;
  const year = Number(match?.[4]);
  // The heading names the weekday too, which must be the date's.
  if (!match || !date || year < 2001 || year > 2100 || new Date(`${date}T12:00:00Z`).getUTCDay() !== WEEKDAYS.indexOf(match[1]!)) {
    return invalid('Transglobal Express returned an unreadable date');
  }
  return date;
}

function row(value: unknown, date: string): Row {
  if (!isRecord(value)) return invalid('Transglobal Express returned an unreadable row');
  const clock = CLOCK.exec(text(value.time, 10));
  const description = text(value.description, 500);
  const location = text(value.location, 200);
  if (!clock || !description) return invalid('Transglobal Express returned an unreadable row');
  const staged = transglobalStage(description);
  return { local_time: `${date}T${clock[1]}:${clock[2]}:00`, description,
    ...(location && !STATE_NOTE.test(location) ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** The partner and number of the parcel's main leg, when the page names one main leg. */
function handoff(legs: unknown[]): { carrier?: string; number?: string } {
  const main = legs.filter((leg) => isRecord(leg) && LEG.exec(text(leg.name, 80))?.[2] === 'Main') as Record<string, unknown>[];
  if (main.length !== 1) return {};
  const number = text(main[0]!.number, 40);
  if (!PARTNER_NUMBER.test(number)) return {};
  const partner = PARTNERS[LEG.exec(text(main[0]!.name, 80))![1]!];
  return { ...(partner ? { carrier: partner } : {}), number };
}

/** Reads the browser service's projection of the result page for one reference. */
export function parseTransglobal(body: unknown): CarrierResult {
  if (!isRecord(body)) return invalid('Transglobal Express returned an unreadable answer');
  if (body.kind === 'not_found') throw new NotFoundError(PROVIDER, 'Transglobal Express does not know this reference');
  if (body.kind !== 'history') return invalid('Transglobal Express answered with a page it does not read');
  if (!Array.isArray(body.legs) || !Array.isArray(body.days) || body.legs.length > 10 || body.days.length > 200) {
    return invalid('Transglobal Express returned an unreadable answer');
  }
  const legs: unknown[] = body.legs;
  const days: unknown[] = body.days;
  const rows = days.flatMap((value) => {
    if (!isRecord(value) || !Array.isArray(value.rows)) return invalid('Transglobal Express returned an unreadable day');
    const date = day(value.date);
    const items: unknown[] = value.rows;
    return items.map((item) => row(item, date));
  });
  if (rows.length > MAX_ROWS) return invalid('Transglobal Express returned too many rows');
  const partner = handoff(legs);
  // An order the page lists without a row: an old one, or a booking with nothing yet.
  if (!rows.length) {
    throw new NoHistoryError(PROVIDER, 'Transglobal Express lists the order without tracking rows', { reason: 'listed',
      ...(partner.carrier && partner.number ? { deliveryCarrier: partner.carrier, deliveryTrackingNumber: partner.number } : {}) });
  }

  // The page lists the newest day first and each day's newest row first.
  const seen = new Set<string>();
  const events = rows.map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  return {
    status: current ? languageStageStatus(current.stage as Stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(partner.carrier && partner.number ? { delivery_carrier: partner.carrier } : {}),
    ...(partner.number ? { delivery_tracking_number: partner.number } : {}),
    events,
  };
}
