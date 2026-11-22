import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { markStage } from './status.js';

export const PROVIDER = 'Mark Express';
export const MARK_ORIGIN = 'https://crm.markerp.in';
/** The tracking page the home page's form opens, with the plain number in `docno`. */
export const MARK_DETAIL = `${MARK_ORIGIN}/Frm_DocTrackWeb.aspx`;
// The page is about 8 kB without scans and 14 kB with five; each scan adds well under two.
export const MARK_MAX_BYTES = 512 * 1024;

// The tracking form takes digits only; the public numbers have nine.
const NUMBER = /^\d{6,12}$/;
// Every office is in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// A day as the page prints it, day first: "23/06/26".
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
// A clock as the page prints it: "09:59 PM".
const CLOCK = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i;
// A day and a clock in one field, as the booking's "23/06/26 - 09:30 PM" or the delivery's "26/06/26-02:57 PM".
const DAY_AND_CLOCK = /^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s*-?\s*(.+))?$/;
// The status line of a number the tracker holds no booking for.
const NOT_FOUND = /^Online Booking Of Specified A\.W\.B\. Is Not Found/i;
// An OUT scan's route names the next office, then the one it left; an IN scan's the office it came from, then the one it reached.
const OUT_ROUTE = /^Out To\s*(.*?)\s*From:\s*(.*)$/i;
const IN_ROUTE = /^From:\s*(.*?)\s*To:\s*(.*)$/i;
// A scan type, as the first column prints it: "IN-Scan", "OUT-Scan".
const JOB = /^[A-Z]{1,10}(?:-[A-Z]{1,10})?$/;
// The page the site sends a request it fails to, a blank error page.
const ERROR_PAGE = /^\/_NotAvailable\.aspx$/i;
// Bot checks a CDN or firewall could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Mark Express air waybill number: digits only, as its tracking form takes them. */
export function normalizeMarkNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Mark Express air waybill numbers are six to twelve digits');
  return number;
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isMarkChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isMarkChallenge(html)) throw new ChallengeError(PROVIDER, 'Mark Express answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/** Whether a redirect goes to the site's blank error page, where it sends a request it fails to. */
export function isMarkErrorPage(location: string | null): boolean {
  try {
    const target = location ? new URL(location, `${MARK_ORIGIN}/`) : null;
    return target?.origin === MARK_ORIGIN && ERROR_PAGE.test(target.pathname);
  } catch {
    return false;
  }
}

/** A day the page prints as dd/mm/yy, as a calendar day, or null. */
function localDay(text: string): string | null {
  const parts = DAY.exec(text);
  if (!parts) return null;
  const year = Number(parts[3]) + (parts[3]!.length === 2 ? 2000 : 0);
  return calendarDay(year, Number(parts[2]), Number(parts[1]));
}

/** A clock the page prints as hh:mm AM, on the 24-hour clock, or null. */
function localClock(text: string): string | null {
  const parts = CLOCK.exec(text);
  const hour = Number(parts?.[1]);
  const minute = Number(parts?.[2]);
  if (!parts || hour < 1 || hour > 12 || minute > 59) return null;
  const hours = (hour % 12) + (parts[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return `${String(hours).padStart(2, '0')}:${parts[2]}:00`;
}

/**
 * A scan's day and clock as the office's wall clock: the page names no zone.
 * A clock of exactly midnight is kept as the day alone, as a row entered
 * without a clock would print. Text that reads as neither is kept as printed.
 */
function wallTime(dayText: string, clockText = ''): Pick<CarrierEvent, 'local_time'> | { provider_time_text: string } {
  const day = localDay(dayText);
  const clock = clockText ? localClock(clockText) : null;
  if (!day || (clockText && !clock)) return { provider_time_text: clean(`${dayText} ${clockText}`, 60) };
  return { local_time: clock && clock !== '00:00:00' ? `${day}T${clock}` : day };
}

/** A field holding a day and a clock, as "23/06/26 - 09:30 PM". */
function wallTimeOf(text: string): ReturnType<typeof wallTime> {
  const parts = DAY_AND_CLOCK.exec(text);
  return parts ? wallTime(parts[1]!, parts[2]) : { provider_time_text: clean(text, 60) };
}

/** An office's name, without phone numbers; '' for none. */
function office(text: string | undefined): string {
  return clean((text ?? '').replace(PHONE, ''), 120);
}

/** A table's data rows, without its header row. */
function dataRows($: CheerioAPI, table: Cheerio<Element>): Element[] {
  return table.find('tr').toArray().filter((row) => $(row).children('td').length > 0);
}

/** An event with its stage, from the carrier's scan type or wording. */
function staged(event: CarrierEvent, code: string | null): CarrierEvent {
  const stage = markStage(code, String(event.description));
  return stage ? { ...event, stage: stage.stage, stage_source: stage.source } : event;
}

/**
 * One row of the transit details: the scan type, its day and clock, and the
 * route. An OUT scan is worded "Out To" the next office, at the office it
 * left; an IN scan "Inward At" the office it reached, as the same courier
 * software words them on other carriers' status lines.
 */
function projectScan($: CheerioAPI, row: Element): CarrierEvent {
  const cells = $(row).children('td');
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Mark Express returned an incomplete scan');
  const job = clean(cells.eq(0).text(), 20).toUpperCase();
  if (!JOB.test(job)) throw new SchemaError(PROVIDER, 'Mark Express returned a scan without its type');
  // The office names' tooltips hold their addresses and phone numbers; only the names are read.
  const route = clean(cells.eq(3).text(), 400);
  const kind = job.replace(/-SCAN$/, '');
  let description: string;
  let location = '';
  if (kind === 'OUT' || kind === 'IN') {
    const parts = (kind === 'OUT' ? OUT_ROUTE : IN_ROUTE).exec(route);
    if (!parts) throw new SchemaError(PROVIDER, 'Mark Express returned a scan with an invalid route');
    const [next, at] = kind === 'OUT' ? [office(parts[1]), office(parts[2])] : ['', office(parts[2])];
    description = kind === 'OUT' ? (next ? `Out To ${next}` : 'Out') : at ? `Inward At ${at}` : 'Inward';
    location = at;
  } else {
    // A scan type not seen yet keeps only its code: its route could name someone.
    description = job;
  }
  return staged({
    ...wallTime(clean(cells.eq(1).text(), 20), clean(cells.eq(2).text(), 20)),
    ...(location ? { location } : {}),
    description,
    provider_code: job,
  }, job);
}

/**
 * One row of the delivery details: its day and clock, the delivering branch
 * and the status. The receiver and the scanned proof of delivery are not read.
 */
function projectDelivery($: CheerioAPI, row: Element): CarrierEvent {
  const cells = $(row).children('td');
  if (cells.length !== 5) throw new SchemaError(PROVIDER, 'Mark Express returned an incomplete delivery');
  const description = clean(cells.eq(3).text().replace(PHONE, ''), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Mark Express returned a delivery without its status');
  const branch = office(cells.eq(1).text());
  return staged({ ...wallTimeOf(clean(cells.eq(0).text(), 60)), ...(branch ? { location: branch } : {}), description }, null);
}

/**
 * The tracking page `Frm_DocTrackWeb.aspx` shows for one air waybill: the
 * booking (from and to centers, day and clock, consignee), a status line, the
 * transit scans and the delivery rows, oldest first. A number the tracker
 * holds nothing for gets the same page with the number, every field empty, a
 * not-found status line and both tables with their headers alone. The page
 * must name the number asked. The consignee is kept; the destination center,
 * the delivery's receiver and the offices' addresses and phone numbers are not.
 */
export function parseMark(html: string, raw: string): CarrierResult {
  const number = normalizeMarkNumber(raw);
  const $ = load(html);
  const shown = $('span#lblDocNumber');
  const status = $('span#lblStatus');
  const fields = ['#txtFromCenter', '#txtToCenter', '#txtDate', '#txtReceiver'].map((id) => $(`span${id}`));
  const track = $('table#tblTrack1');
  const delivery = $('table#tblDelivery');
  if (shown.length !== 1 || status.length !== 1 || fields.some((field) => field.length !== 1) || track.length !== 1 || delivery.length !== 1) {
    unexpected(html, 'Mark Express returned a page without its tracking detail');
  }
  if (normalizeTrackingNumber(clean(shown.text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Mark Express answered for another air waybill');
  }

  const [from, , booked, consignee] = fields.map((field) => clean(field.text(), 200)) as [string, string, string, string];
  const line = clean(status.text().replace(PHONE, ''), 200);
  const scans = dataRows($, track);
  const deliveries = dataRows($, delivery);
  if (!from && !booked && !consignee && !scans.length && !deliveries.length) {
    if (NOT_FOUND.test(line)) throw new NotFoundError(PROVIDER);
    unexpected(html, 'Mark Express returned an empty page without its not-found notice');
  }
  if (scans.length + deliveries.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Mark Express returned an oversized history');

  const fromOffice = office(from);
  const listed: CarrierEvent[] = [
    ...(booked ? [staged({
      ...wallTimeOf(booked), ...(fromOffice ? { location: fromOffice } : {}), description: fromOffice ? `Booked By ${fromOffice}` : 'Booked',
    }, null)] : []),
    ...scans.map((row) => projectScan($, row)),
    ...deliveries.map((row) => projectDelivery($, row)),
  ];
  const seen = new Set<string>();
  const unique = listed.filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The page lists the booking, then the scans and the deliveries, oldest first. A row with a day
  // alone, or no readable day, keeps the place of the row before it on the same day.
  let previous = '';
  const keyed = unique.map((event) => {
    const local = typeof event.local_time === 'string' ? event.local_time : '';
    const key = !local || (local.length === 10 && previous.startsWith(local)) ? previous : local;
    previous = key;
    return { event, key };
  });
  // Newest first; rows that share a time keep their order.
  const events = [...keyed].reverse().sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? 1 : -1)).map(({ event }) => event);

  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Mark Express lists the air waybill without a dated scan', { reason: 'listed' });
  // The status line sums the consignment up, as "DELIVERED ON 26/06/26 BY THANE-HUB (MUMBAI)"; it gives
  // the stage when its wording maps to one, else the newest staged row does.
  const current = line && !NOT_FOUND.test(line) ? line : '';
  const summed = current ? markStage(null, current) : null;
  const latest = events.find((event) => event.stage);
  const stage = summed?.stage ?? (latest?.stage as Stage | undefined);
  const source = summed?.source ?? latest?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: current || String(newest.description),
    last_update: null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    timezone: ZONE,
    ...(/\p{L}/u.test(consignee) ? { receiver_name: consignee } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
