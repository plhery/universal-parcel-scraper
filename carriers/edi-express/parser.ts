import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, canadaProvinceTimeZone, usStateTimeZone } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { ediStage, statusMap } from './status.js';

export const PROVIDER = 'EDI Express';
/** The page the trace form posts a PRO number to, as `p`. */
export const EDI_LOOKUP = 'https://my.ediexpressinc.com/prodetail.asp';
// A shipment's page is about 25 kB, most of it the site around the details.
export const EDI_MAX_BYTES = 512 * 1024;

// An EDI Express PRO number: nine digits, the length of the trace form's field.
const NUMBER = /^\d{9}$/;
// The page's answer for a PRO it has no shipment under. It names no number.
const NOT_FOUND = 'No data available';
// "11/2/2021": the days of the page's dated fields.
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// The day an estimate or appointment starts with.
const LEADING_DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;
// The shipment status ends with the day it was set: "Trailer dispatched to AZ on 10/27/2021".
const DATED_STATUS = /^(.*\S)\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i;
const WEIGHT = /^(\d{1,7}(?:\.\d{1,3})?)\s*lbs\.?$/i;
const POUNDS_TO_KG = 0.453_592_37;
// A firewall's or bot check's page, which can come back with HTTP 200.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|requested URL was rejected/i;
// The labels of the shipment details the parser reads; the PO number and the terms are not read.
const INVOICE = 'INVOICE NO:';
const PICKUP = 'Pickup Date:';
const ESTIMATE = 'Est Del Date:';
const REVISED = 'Rev Est Del Date:';
const OUT_FOR_DELIVERY = 'Out for Del:';
const DELIVERED = 'DEL Date:';
const APPOINTMENT = 'Appointment:';
const STATUS = 'Shipment Status:';
const DETAILS = [INVOICE, PICKUP, ESTIMATE, REVISED, OUT_FOR_DELIVERY, DELIVERED, APPOINTMENT];
const SETTLED = new Set<Stage>(['delivered', 'returned']);

/** An EDI Express PRO number: nine digits. Anything else is not one the trace form takes. */
export function normalizeEdiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'EDI Express PRO numbers are nine digits');
  return number;
}

/** Whether a page is a firewall's or a bot check's instead of the tracker's. */
export function isEdiBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

const invalid = (message = 'EDI Express changed its shipment details'): never => { throw new SchemaError(PROVIDER, message); };

/** The value in the cell beside each of the labels asked for, within a part of the page. */
function labelled($: CheerioAPI, scope: Cheerio<AnyNode>, labels: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  scope.find('td').each((_, node) => {
    const cell = $(node);
    const label = clean(cell.text(), 40);
    if (!labels.includes(label)) return;
    if (values.has(label)) invalid('EDI Express repeated a detail of the shipment');
    values.set(label, clean(cell.next('td').text(), 200));
  });
  return values;
}

/** A dated field's day as `YYYY-MM-DD`, or null when the page leaves it empty. */
function dayOf(value: string | undefined): string | null {
  if (!value) return null;
  const match = DAY.exec(value);
  return (match && calendarDay(Number(match[3]), Number(match[1]), Number(match[2]))) || invalid('EDI Express returned an invalid date');
}

/** The day an estimate or appointment starts with, or null without one. */
function estimateDay(value: string | undefined): string | null {
  const match = LEADING_DAY.exec(value ?? '');
  return match ? calendarDay(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

interface Dated { event: CarrierEvent; rank: number }

/** A milestone of the page, with the order it takes among those of its day. */
function dated(local_time: string, description: string, rank: number, original?: string): Dated {
  const staged = ediStage(description);
  return { rank, event: {
    local_time,
    description,
    ...(original ? { original_description: original } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The consignee's town and state, from the row under its label: the page leaves the
 * consignee's name and phone empty, and the ZIP code is not read.
 */
function consigneeOf($: CheerioAPI): string {
  const label = $('td').filter((_, node) => clean($(node).text(), 20) === 'CONSIGNEE:');
  if (label.length !== 1) return '';
  const row = label.closest('tr').nextAll('tr').filter((_, node) => clean($(node).children('td').first().text(), 20) === 'City:').first();
  const cells = row.children('td');
  if (cells.length < 4 || clean(cells.eq(2).text(), 20) !== 'State:') return '';
  const town = clean(cells.eq(1).text(), 60);
  const state = clean(cells.eq(3).text(), 4);
  return town && /^[A-Z]{2}$/.test(state) ? `${town}, ${state}` : '';
}

/** The country of a "TOWN, XX" place from its state or province. */
function countryOf(place: string): string | null {
  const region = /,\s*([A-Z]{2})$/.exec(place)?.[1];
  if (!region) return null;
  return canadaProvinceTimeZone(region) ? 'CA' : usStateTimeZone(region) ? 'US' : null;
}

/** The total weight of the freight in pounds, as kilograms. */
function weightOf($: CheerioAPI): number | null {
  const total = $('td').filter((_, node) => clean($(node).text(), 20) === 'Total:');
  if (total.length !== 1) return null;
  const pounds = Number(WEIGHT.exec(clean(total.nextAll('td').eq(1).text(), 40))?.[1] ?? 0);
  return pounds > 0 ? Math.round(pounds * POUNDS_TO_KG * 1000) / 1000 : null;
}

/**
 * The page `POST my.ediexpressinc.com/prodetail.asp` renders for one PRO number: the shipment
 * details (the PRO number as its invoice number, the pickup day, the estimated and revised
 * delivery days, the out-for-delivery and delivery days, an appointment), the shipment status
 * with the day it was set, the shipper's, consignee's and bill-to party's towns, and the freight's
 * pieces and weight. A PRO it has no shipment under gets "No data available" in place of the
 * details. Visitors get no scan history; it needs an account.
 */
export function parseEdiExpress(html: string, rawNumber: string): CarrierResult {
  const number = normalizeEdiNumber(rawNumber);
  const $ = load(html);
  const heading = $('h2').filter((_, node) => clean($(node).text(), 40) === 'Shipment Details');
  if (heading.length !== 1) {
    if (isEdiBlocked(html)) throw new ChallengeError(PROVIDER, 'EDI Express answered with a block page');
    invalid('EDI Express did not return its shipment details');
  }
  const table = heading.nextAll('table').first();
  if (!table.length) invalid();
  const details = labelled($, table, DETAILS);
  const invoice = details.get(INVOICE);
  if (!invoice) {
    // The answer does not repeat the number; the request for it does.
    if (clean(table.text(), 200) === NOT_FOUND) throw new NotFoundError(PROVIDER, 'EDI Express has no shipment under this PRO number');
    return invalid('EDI Express returned shipment details without the PRO number');
  }
  if (normalizeTrackingNumber(invoice) !== number) throw new IndeterminateError(PROVIDER, 'EDI Express answered for another shipment');

  const status = labelled($, $.root(), [STATUS]).get(STATUS) ?? '';
  const milestones: Dated[] = [];
  const pickup = dayOf(details.get(PICKUP));
  if (pickup) milestones.push(dated(pickup, 'Picked up', 0));
  const set = DATED_STATUS.exec(status);
  if (set) {
    const day = calendarDay(Number(set[4]), Number(set[2]), Number(set[3])) ?? invalid('EDI Express returned an invalid status date');
    milestones.push(dated(day, clean(set[1], 200), 1, status));
  }
  const out = dayOf(details.get(OUT_FOR_DELIVERY));
  if (out) milestones.push(dated(out, 'Out for delivery', 2));
  const delivered = dayOf(details.get(DELIVERED));
  if (delivered) milestones.push(dated(delivered, 'Delivered', 3));
  // Newest first; a day's milestones in the order a shipment reaches them.
  const events = milestones
    .sort((a, b) => (a.event.local_time === b.event.local_time ? b.rank - a.rank : String(a.event.local_time) < String(b.event.local_time) ? 1 : -1))
    .map(({ event }) => event);

  const consignee = consigneeOf($);
  const destination = countryOf(consignee);
  const weight = weightOf($);
  const facts = {
    ...(weight !== null ? { weight_kg: weight } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(consignee ? { receiver_address: consignee } : {}),
  };
  // The appointment's day once one is made, else the revised estimate, else the first one.
  const estimate = estimateDay(details.get(APPOINTMENT)) ?? estimateDay(details.get(REVISED)) ?? estimateDay(details.get(ESTIMATE));
  const newest = events[0];
  if (!newest) {
    // A status without its day stands alone only when no milestone is dated.
    const summary = status ? ediStage(status) : null;
    if (!summary) throw new NoHistoryError(PROVIDER, 'EDI Express lists the shipment without a status it can read', { reason: 'listed' });
    return {
      status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: summary.source,
      last_status_text: status, last_update: null, expected_delivery: SETTLED.has(summary.stage) ? null : estimate,
      ...facts, summary_only: true, events: [],
    };
  }
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description ?? null,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: stage && SETTLED.has(stage) ? null : estimate,
    ...facts,
    summary_only: true,
    events,
  };
}
