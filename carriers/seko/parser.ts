import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isSekoBookkeeping, sekoStage } from './status.js';

export const PROVIDER = 'SEKO Logistics';
// The page is about 140 kB; a long history adds a few.
export const SEKO_MAX_BYTES = 1024 * 1024;
/**
 * SEKO's own shipment numbers: a shipper's letters before seven digits, or
 * digits alone. The tracker also finds forwarding shipments by their booking
 * reference, so a short reference could name someone else's shipment; only a
 * whole number with a seven-digit run is sent.
 */
const NUMBER = /^(?=[A-Z0-9]*\d{7})[A-Z0-9]{8,20}$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
/** The part of the page that answers the query, before the site's footer. */
export const SEKO_SECTION = '<div class="package-tracking">';
const SHIPMENT = /<div class="[^"]*\bshipment-details\b[^"]*">/g;
const SHIPMENT_NUMBER = /<h1 class="[^"]*\bfw-bold\b[^"]*">([\s\S]*?)<\/h1>/;
const NOT_FOUND = /<p class="text-danger">\s*No results found for tracking number:([\s\S]*?)<\/p>/;
const FIELD = /<p class="[^"]*\bfw-bold\b[^"]*">([^<]*?):\s*<\/p>\s*<\/div>\s*<div class="col-7">\s*<p class="[^"]*">([\s\S]*?)<\/p>/g;
const ESTIMATE = /<p class="due-date">([\s\S]*?)<\/p>/;
// The wide screen's table; narrow screens get the same rows again as paragraphs.
const HISTORY = /<table class="[^"]*">([\s\S]*?)<\/table>/;
const ROW = /<tr>([\s\S]*?)<\/tr>/g;
const CELL = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g;
const TWELVE_HOUR = /^(?:0?[1-9]|1[0-2]):[0-5]\d [AP]M$/;
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** A number for SEKO's tracker, in capitals; anything else is not one it issues. */
export function normalizeSekoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'SEKO numbers are eight to twenty letters and digits, with at least seven digits in a row');
  return number;
}

/** The text of a page fragment, its tags gone and its entities read. */
export function pageText(fragment: string, maxLength = 300): string {
  return clean(fragment.replace(/<[^>]*>/g, ' ').replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (entity, decimal?: string, hex?: string, name?: string) => {
    const code = decimal ? Number(decimal) : hex ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined) return code > 0 && code <= 0x10_ffff ? String.fromCodePoint(code) : entity;
    return ENTITIES[name!.toLowerCase()] ?? entity;
  }), maxLength);
}

/** A US calendar day the page writes, such as `Dec 19, 2025` or `8/24/2026`. */
function calendarDay(value: string, format: string): string {
  const day = DateTime.fromFormat(value, format, { zone: 'UTC', locale: 'en-US' });
  if (!day.isValid) throw new SchemaError(PROVIDER, 'SEKO returned an invalid delivery estimate');
  return day.toISODate();
}

/** The expected day, or the window the page gives instead; other wording gives none. */
function estimate(shipment: string): Pick<CarrierResult, 'expected_delivery' | 'expected_delivery_from'> {
  const wording = pageText(ESTIMATE.exec(shipment)?.[1] ?? '', 120);
  const day = /^Expected Arrival\s*:\s*([A-Z][a-z]{2} \d{1,2}, \d{4})$/i.exec(wording)?.[1];
  if (day) return { expected_delivery: calendarDay(day, 'LLL d, yyyy') };
  const window = /^Estimated delivery between\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(wording);
  if (!window) return {};
  const from = calendarDay(window[1]!, 'M/d/yyyy');
  const to = calendarDay(window[2]!, 'M/d/yyyy');
  return { expected_delivery: to, ...(to > from ? { expected_delivery_from: from } : {}) };
}

/**
 * A milestone's clock: SEKO's own wall clock, to the minute, with no zone.
 * The delivery's milestone runs one or two hours off the proof of delivery's
 * clock at the address, so the clocks are not the scanning place's either.
 */
function wallClock(date: string, time: string): string {
  // Parsing in UTC checks the calendar and the clock only; the wall clock keeps no offset.
  const local = DateTime.fromFormat(`${date} ${time}`, 'M/d/yyyy h:mm a', { zone: 'UTC', locale: 'en-US' });
  // Luxon takes 13:05 PM as 13:05.
  if (!local.isValid || !TWELVE_HOUR.test(time)) throw new SchemaError(PROVIDER, 'SEKO returned an invalid milestone time');
  return local.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function projectMilestone(row: string): CarrierEvent | null {
  const cells = [...row.matchAll(CELL)].map((cell) => pageText(cell[1]!));
  if (cells.length !== 3) throw new SchemaError(PROVIDER, 'SEKO returned an invalid milestone');
  const [date, time, description] = cells as [string, string, string];
  if (!description) throw new SchemaError(PROVIDER, 'SEKO returned a milestone without wording');
  const local = wallClock(date, time);
  if (isSekoBookkeeping(description)) return null;
  const staged = sekoStage(description);
  return {
    local_time: local,
    description,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The shipment the page shows for the number asked, or the page's answer that it has none. */
function shipmentOf(section: string, number: string): string {
  const starts = [...section.matchAll(SHIPMENT)].map((match) => match.index);
  if (!starts.length) {
    const missing = NOT_FOUND.exec(section);
    if (!missing) throw new SchemaError(PROVIDER, 'SEKO returned a tracking page without a shipment or an answer');
    const asked = /^"(.*)"\.?$/.exec(pageText(missing[1]!, 80))?.[1];
    if (asked === undefined || normalizeTrackingNumber(asked) !== number) throw new IndeterminateError(PROVIDER, 'SEKO answered for another number');
    throw new NotFoundError(PROVIDER);
  }
  const shipments = starts.map((start, index) => section.slice(start, starts[index + 1]));
  const own = shipments.filter((shipment) => {
    const shown = SHIPMENT_NUMBER.exec(shipment)?.[1];
    if (shown === undefined) throw new SchemaError(PROVIDER, 'SEKO returned a shipment without its number');
    return normalizeTrackingNumber(pageText(shown, 64)) === number;
  });
  if (own.length !== 1) throw new IndeterminateError(PROVIDER, own.length ? 'SEKO answered with several shipments for the number' : 'SEKO answered for another shipment');
  return own[0]!;
}

/**
 * SEKO's tracking page for `?trackingNumbers={number}`, rendered on SEKO's
 * server: the shipment's summary, its step rail and its milestones oldest
 * first, or a line that it found nothing for the number.
 */
export function parseSekoPage(page: string, raw: string): CarrierResult {
  const number = normalizeSekoNumber(raw);
  const start = page.indexOf(SEKO_SECTION);
  if (start < 0) throw new SchemaError(PROVIDER, 'SEKO returned a page without its tracking section');
  const end = page.indexOf('<footer', start);
  const shipment = shipmentOf(page.slice(start, end < 0 ? undefined : end), number);
  const fields = new Map([...shipment.matchAll(FIELD)].map(([, label, value]) => [pageText(label!, 80).toLowerCase(), pageText(value!)]));
  const listed = fields.get('tracking number');
  if (listed !== undefined && normalizeTrackingNumber(listed) !== number) throw new IndeterminateError(PROVIDER, 'SEKO answered for another shipment');

  const table = HISTORY.exec(shipment)?.[1] ?? '';
  const rows = [...table.matchAll(ROW)].map((row) => row[1]!);
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'SEKO returned an oversized history');
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of rows) {
    const event = projectMilestone(row);
    if (!event) continue;
    // The history repeats a status change, sometimes in another case, within a minute.
    const key = `${event.local_time as string} ${event.description!.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // The page lists milestones oldest first, but the newest first within a minute,
  // so equal clocks keep its order.
  const newestFirst = events.map((event, index) => ({ event, index }))
    .sort((left, right) => (right.event.local_time as string).localeCompare(left.event.local_time as string) || left.index - right.index)
    .map(({ event }) => event);
  const newest = newestFirst[0];
  if (!newest) throw new NoHistoryError(PROVIDER);

  // The step rail is not read: the milestones name each status it shows, and holds besides.
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const finished = stage === 'delivered' || stage === 'returned';
  const service = fields.get('service') ?? '';
  const destination = countryCode(/\b([A-Z]{2})$/.exec(fields.get('destination') ?? '')?.[1]);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(finished ? {} : estimate(shipment)),
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
