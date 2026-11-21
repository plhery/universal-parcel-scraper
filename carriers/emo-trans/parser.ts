import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { emoTransStage } from './status.js';

export const PROVIDER = 'emo-trans';
// A search answers a page of at most ten rows; a shipment's page is a few dozen kilobytes.
export const EMO_TRANS_MAX_BYTES = 1024 * 1024;

// The tracker takes a shipment number (EMO's own, or its S-number), a house bill and other references, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "02-FEB-2026" and "09:41:43 AM": a station's wall clock, without a zone.
const DAY = /^(\d{2})-([A-Z]{3})-(\d{4})$/;
const CLOCK = /^(0\d|1[0-2]):([0-5]\d)(?::([0-5]\d))? ([AP]M)$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_EVENTS = 300;
const CHALLENGE = /<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|h-captcha|cf-turnstile|captcha/i;

/** A number for EMO Trans's quick track: a shipment number, an S-number or a house bill. */
export function normalizeEmoTransNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the EMO Trans shipment or house bill number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** One row of the quick track's search: the shipment's page id and the numbers it goes by. */
export interface EmoTransRow { gid: number; shipmentNumber: string; houseBill: string | null; mode: string | null }

const text = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? clean(value, 120) || null : invalid(`EMO Trans returned an invalid ${field}`);
};

function rowOf(value: unknown): EmoTransRow {
  if (!isRecord(value) || typeof value.shipmentGid !== 'number' || !Number.isSafeInteger(value.shipmentGid) || value.shipmentGid <= 0) {
    return invalid('EMO Trans returned an invalid shipment row');
  }
  const shipmentNumber = text(value.shipmentNumber, 'shipment number') ?? invalid('EMO Trans returned a shipment without its number');
  return { gid: value.shipmentGid, shipmentNumber, houseBill: text(value.houseBillNumber, 'house bill'), mode: text(value.mode, 'mode') };
}

/** The numbers a shipment goes by: each part of "15112600391 / S2601A00324070" and its house bill. */
const namesOf = (shipmentNumber: string, houseBill: string | null): string[] => [...shipmentNumber.split('/'), houseBill ?? '']
  .map((part) => normalizeTrackingNumber(part.trim())).filter(Boolean);

/**
 * The shipment a search answer names for a number, or null when the quick track found none. The
 * search also matches master bills, containers and other references several shipments share: a
 * row counts only when the number is its own shipment number or house bill.
 */
export function emoTransSearchRow(payload: unknown, number: string): EmoTransRow | null {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > 100
    || typeof payload.recordsTotal !== 'number' || typeof payload.recordsFiltered !== 'number') {
    return invalid('EMO Trans returned an unreadable search answer');
  }
  if (payload.data.length === 0) {
    return payload.recordsFiltered === 0 ? null : invalid('EMO Trans counted shipments it did not list');
  }
  const rows = payload.data.map(rowOf);
  const named = rows.filter((row) => namesOf(row.shipmentNumber, row.houseBill).includes(number));
  if (named.length === 0) throw new IndeterminateError(PROVIDER, 'EMO Trans lists shipments that do not go by this number');
  if (new Set(named.map((row) => row.gid)).size > 1) throw new IndeterminateError(PROVIDER, 'EMO Trans lists several shipments under this number');
  return named[0]!;
}

function dayOf(value: string): string | null {
  const parts = DAY.exec(value);
  const month = parts ? MONTHS.indexOf(parts[2]!) + 1 : 0;
  return parts && month && Number(parts[3]) > 2000 ? calendarDay(Number(parts[3]), month, Number(parts[1])) : null;
}

function wallClockOf(day: string, time: string): string {
  const date = dayOf(day) ?? invalid('EMO Trans returned an invalid event date');
  if (!time) return date;
  const parts = CLOCK.exec(time) ?? invalid('EMO Trans returned an invalid event time');
  const hour = (Number(parts[1]) % 12) + (parts[4] === 'PM' ? 12 : 0);
  return `${date}T${String(hour).padStart(2, '0')}:${parts[2]}:${parts[3] ?? '00'}`;
}

/** The values of a two-column table, by their label. */
function fields($: CheerioAPI, heading: string): Map<string, Cheerio<Element>> {
  const table = $('.infoTable table').filter((_, element) => clean($(element).find('thead td').first().text()) === heading);
  if (table.length !== 1) return invalid(`EMO Trans returned a shipment page without its ${heading.toLowerCase()}`);
  return new Map(table.find('tbody > tr').toArray().map((row) => {
    const cells = $(row).children('td');
    return [clean(cells.first().text(), 60), cells.eq(1)] as const;
  }));
}

/** The events table: newest first, each with its description, its station's wall clock and its station. */
function eventsOf($: CheerioAPI): (CarrierEvent & { local_time: string })[] {
  const table = $('.infoTable table').filter((_, element) => clean($(element).find('thead td').first().text()) === 'Event Description');
  const headings = table.find('thead td').toArray().map((cell) => clean($(cell).text(), 40));
  if (table.length !== 1 || headings.join('|') !== 'Event Description|Date / Time|Location') {
    return invalid('EMO Trans changed its events table');
  }
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_EVENTS) return invalid('EMO Trans returned too many events');
  return rows.flatMap((row, index) => {
    const cells = $(row).children('td');
    if (cells.length !== 3) return invalid('EMO Trans returned an incomplete event');
    const description = clean(cells.eq(0).text(), 200);
    const time = clean(cells.eq(1).find('.time').text(), 20);
    const day = clean(cells.eq(1).clone().children('.time').remove().end().text(), 20);
    const location = clean(cells.eq(2).text(), 120);
    if (!description) return invalid('EMO Trans returned an event without a description');
    // A milestone the page lists before it happens has no date yet.
    if (!day || day === 'N/A') return [];
    const stage = emoTransStage(description);
    const event: CarrierEvent & { local_time: string } = { local_time: wallClockOf(day, time), description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return [{ index, event }];
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
}

/**
 * Reads a shipment's page. It must be the page of the shipment the search named. Names and
 * addresses do not appear on it; the events keep their station's wall clock, as the page gives
 * no zone and a shipment's stations lie in several.
 */
export function parseEmoTransShipment(html: string, row: EmoTransRow): CarrierResult {
  if (CHALLENGE.test(html)) throw new ChallengeError(PROVIDER, 'EMO Trans returned a verification page');
  const $ = load(html);
  if (!/^Quick Track - Emo Trans/i.test(clean($('title').text()))) return invalid('EMO Trans returned a page that is not a shipment');
  const summary = fields($, 'Shipment Summary');
  const shown = clean(summary.get('Shipment Number')?.text(), 120);
  const names = namesOf(row.shipmentNumber, row.houseBill);
  if (!shown || namesOf(shown, null).join('/') !== namesOf(row.shipmentNumber, null).join('/')) {
    throw new IndeterminateError(PROVIDER, 'EMO Trans opened another shipment');
  }
  const houseBill = clean(summary.get('House Bill Number')?.text(), 60);
  if (houseBill && row.houseBill && !names.includes(normalizeTrackingNumber(houseBill))) {
    throw new IndeterminateError(PROVIDER, 'EMO Trans opened another shipment');
  }
  const lastStatus = clean(summary.get('Last Status')?.text(), 200);
  const destination = clean(summary.get('Destination')?.text(), 120).split(' ').at(-1);
  const doorEta = dayOf(clean(fields($, 'Dates').get('Door ETA')?.text(), 20));
  const events = eventsOf($);
  if (!lastStatus && events.length === 0) return invalid('EMO Trans returned a shipment without a status or events');

  // The summary's last status can be further on than the newest event, as a delivery is.
  const stage = emoTransStage(lastStatus) ?? events.map((event) => emoTransStage(event.description ?? '')).find(Boolean);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: lastStatus || events[0]?.description || null,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: stage !== 'delivered' ? doorEta : null,
    ...(countryCode(destination) ? { destination_country: countryCode(destination)! } : {}),
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
