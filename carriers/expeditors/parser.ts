import { DateTime, FixedOffsetZone } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, PlannedEvent } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { expeditorsStage } from './status.js';

export const PROVIDER = 'expeditors';
// A shipment and its events take a few kilobytes; a search that matches customer references lists more.
export const EXPEDITORS_MAX_BYTES = 1024 * 1024;

// An Expeditors reference: its branch's two digits, then a letter or a digit and seven digits.
const NUMBER = /^\d{2}[A-Z0-9]\d{7}$/;
const MAX_RESULTS = 500;
const MAX_EVENTS = 500;
// "02-Feb-2026 17:00 CST": the wall clock an event's instant reads on where it happened. Older replies leave out the year.
const WALL = /^(\d{1,2})-([A-Za-z]{3})(?:-(\d{4}))? ([01]\d|2[0-3]):([0-5]\d)(?: [A-Z]{1,6})?$/;
// "02-Feb-2026 CST": the day a target falls on.
const DAY = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\b/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_OFFSET_MINUTES = 14 * 60;
// Estimates and the delivery date the client asked for: steps written before they happen, not scans.
const PLANNED = /^(?:Est\b|Estimated\b|Requested Delivery Date$)/i;
const DELIVERY_ESTIMATE = /^Est(?:imated)? Delivery to Consignee$/i;

/** A number for Expeditors' guest tracker: the shipment's Expeditors reference. */
export function normalizeExpeditorsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Expeditors reference of the shipment');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The Expeditors reference a search result or a detail reply names. */
function referenceOf(entry: unknown): string {
  const attributes = isRecord(entry) ? entry.shipmentAttributes : undefined;
  const reference = isRecord(attributes) ? clean(attributes.expeditorsReference, 64) : '';
  return reference ? normalizeTrackingNumber(reference) : invalid('Expeditors returned a shipment without its reference');
}

/**
 * The shipment the guest search finds under the number. A search that matches one shipment returns
 * that shipment's details, which come back as `shipment`; one that matches several lists them, and
 * the details of the one under the number are still to be read. The search also matches customer
 * references, such as orders and invoices: only a shipment whose own reference is the number is it.
 */
export function pickExpeditorsShipment(payload: unknown, number: string): { shipment: Record<string, unknown> | null } {
  if (!isRecord(payload)) return invalid('Expeditors returned an unreadable search reply');
  if (!('shipmentResults' in payload)) {
    if (referenceOf(payload) === number) return { shipment: payload };
    throw new IndeterminateError(PROVIDER, 'The number matched only a reference of another Expeditors shipment', { reason: 'reference_only' });
  }
  const results = payload.shipmentResults;
  if (!Array.isArray(results) || results.length > MAX_RESULTS) return invalid('Expeditors returned an invalid search list');
  if (results.length === 0) throw new NotFoundError(PROVIDER, 'Expeditors has no shipment under this reference');
  if (results.some((entry) => referenceOf(entry) === number)) return { shipment: null };
  throw new IndeterminateError(PROVIDER, 'The number matched only references of other Expeditors shipments', { reason: 'reference_only' });
}

function monthOf(name: string): number {
  return MONTHS.indexOf(name.toUpperCase()) + 1;
}

/**
 * An event's time. The reply gives its instant in UTC and the wall clock it reads on where it
 * happened: the instant keeps that clock's offset, which the two give together. When they do not
 * give a zone's offset, the instant stands alone, in UTC.
 */
function eventTime(date: unknown, formatted: unknown): { at: number; time: string } {
  const instant = explicitOffsetTime(date);
  if (!instant) return invalid('Expeditors returned an invalid event date');
  const at = instant.timestamp;
  const wall = WALL.exec(clean(formatted, 40));
  const month = wall ? monthOf(wall[2]!) : 0;
  const year = new Date(at).getUTCFullYear();
  const offsets = !wall || !month ? [] : (wall[3] ? [Number(wall[3])] : [year - 1, year, year + 1]).map((candidate) => {
    const day = calendarDay(candidate, month, Number(wall[1]));
    return day ? (Date.parse(`${day}T${wall[4]}:${wall[5]}:00Z`) - at) / 60_000 : Number.NaN;
  });
  const offset = offsets.find((minutes) => Number.isInteger(minutes) && minutes % 15 === 0 && Math.abs(minutes) <= MAX_OFFSET_MINUTES);
  const zone = offset === undefined ? FixedOffsetZone.utcInstance : FixedOffsetZone.instance(offset);
  return { at, time: DateTime.fromMillis(at, { zone }).toISO({ suppressMilliseconds: true })! };
}

/** The one place an event names; a leg from one place to another does not say where it was written. */
function placeOf(row: Record<string, unknown>): string | undefined {
  const places = [clean(row.origin, 120), clean(row.destination, 120)].filter(Boolean);
  return places.length === 1 ? places[0] : undefined;
}

interface Row { at: number; index: number; planned: boolean; event: CarrierEvent & { time: string; description: string } }

/** The rows of the events section, newest first as the reply lists them. Remarks stay behind. */
function rowsOf(payload: unknown, number: string): Row[] {
  if (!isRecord(payload) || referenceOf(payload) !== number) return invalid('Expeditors returned events for another shipment');
  const events = (payload.shipmentAttributes as Record<string, unknown>).events;
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return invalid('Expeditors returned an invalid event list');
  return events.flatMap((row, index): Row[] => {
    const event = isRecord(row) && isRecord(row.event) ? row.event : invalid('Expeditors returned an invalid event');
    const description = clean(event.description, 200) || invalid('Expeditors returned an event without its wording');
    const planned = PLANNED.test(description);
    // An estimate the reply has no date for yet is no step at all.
    if (planned && !clean(event.date, 64)) return [];
    const { at, time } = eventTime(event.date, event.formattedDate);
    const location = placeOf(row as Record<string, unknown>);
    const stage = planned ? undefined : expeditorsStage(description);
    return [{ at, index, planned, event: { time, description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } }];
  });
}

/** The status change the shipment's status reports, which the events section leaves out. */
function statusChange(details: Record<string, unknown>): Row | null {
  const status = isRecord(details.shipmentStatus) ? details.shipmentStatus : {};
  const change = isRecord(status.lastStatusChangeEvent) ? status.lastStatusChangeEvent.event : undefined;
  if (!isRecord(change)) return null;
  const description = clean(change.description, 200);
  if (!description || !clean(change.date, 64)) return null;
  const { at, time } = eventTime(change.date, change.formattedDate);
  const stage = expeditorsStage(description);
  return { at, index: -1, planned: false, event: { time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
}

/** The day of the delivery the guest page announces, as its own clock gives it. */
function targetDay(details: Record<string, unknown>): string | null {
  const arrival = isRecord(details.shipmentArrivalStatus) ? details.shipmentArrivalStatus : {};
  const target = isRecord(arrival.targetStatusEvent) ? arrival.targetStatusEvent : {};
  if (clean(target.description, 80) !== 'Estimated Delivery') return null;
  const day = DAY.exec(clean(target.formattedDate, 40));
  return day ? calendarDay(Number(day[3]), monthOf(day[2]!), Number(day[1])) : null;
}

function weightKg(details: Record<string, unknown>): number | null {
  const weight = isRecord(details.weight) ? details.weight : {};
  return weight.unit === 'K' && typeof weight.quantity === 'number' && Number.isFinite(weight.quantity) && weight.quantity > 0
    ? weight.quantity : null;
}

/**
 * A shipment from its details and its events section. The events, their places and the status
 * the shipment is in are read; the parties, the customer's references, the carrier's flight or
 * voyage, the pieces and the volume, and every event's remarks stay behind.
 */
export function parseExpeditors(details: unknown, events: unknown, number: string): CarrierResult {
  if (!isRecord(details) || referenceOf(details) !== number) return invalid('Expeditors returned details of another shipment');
  const rows = rowsOf(events, number);
  const change = statusChange(details);
  const seen = new Set<string>();
  const scans = [...rows.filter((row) => !row.planned), ...(change ? [change] : [])].filter((row) => {
    const key = JSON.stringify([row.at, row.event.description.toLowerCase()]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.at - a.at || a.index - b.index).map((row) => row.event);

  const statusText = clean(isRecord(details.shipmentStatus) ? details.shipmentStatus.description : '', 200);
  const listed = statusText ? expeditorsStage(statusText) : undefined;
  const stage: Stage | undefined = listed ?? scans.find((event) => event.stage)?.stage as Stage | undefined;
  const finished = stage === 'delivered' || stage === 'returned';
  const planned: PlannedEvent[] = finished ? [] : rows.filter((row) => row.planned).sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ event }) => ({ time: event.time, description: event.description, ...(event.location ? { location: event.location } : {}) }));
  if (scans.length === 0) {
    throw new NoHistoryError(PROVIDER, 'Expeditors lists the shipment without events', { reason: 'listed', plannedEvents: planned });
  }
  const estimate = finished ? null : rows.find((row) => row.planned && DELIVERY_ESTIMATE.test(row.event.description))?.event.time.slice(0, 10)
    ?? targetDay(details);
  const weight = weightKg(details);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: statusText || scans[0]!.description,
    last_update: scans[0]!.time,
    expected_delivery: estimate,
    ...(weight ? { weight_kg: weight } : {}),
    ...(planned.length ? { planned_events: planned } : {}),
    events: scans,
  };
}
