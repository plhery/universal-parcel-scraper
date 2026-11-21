import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { mahavirStage } from './status.js';

export const PROVIDER = 'Shree Mahavir Express Services';
export const MAHAVIR_ORIGIN = 'https://www.shreemahavircourier.com';
/** The home page, whose tracking form posts the number back to itself. */
export const MAHAVIR_FORM = `${MAHAVIR_ORIGIN}/Index.aspx`;
/** The tracking detail, opened with the key the server encrypts the number into. */
export const MAHAVIR_DETAIL = `${MAHAVIR_ORIGIN}/Frm_DocTrack.aspx`;
// The home page is about 40 kB and the tracking detail about 11 kB; each scan adds well under one.
export const MAHAVIR_MAX_BYTES = 512 * 1024;

// The tracking form asks for twelve-digit consignment numbers.
const NUMBER = /^\d{12}$/;
// Every office is in India, which keeps UTC+5:30 all year.
const ZONE = 'Asia/Kolkata';
// A day as the page prints it, day first: "20/08/26".
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
// A clock as the page prints it: "07:07 PM".
const CLOCK = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i;
// A day and a clock in one field, as the booking's "20/08/26 - 06:29 PM".
const DAY_AND_CLOCK = /^(\S+)(?:\s*-?\s+(.+))?$/;
// The status line, as "Inward At SAMPLE Dated 21/08/26".
const STATUS_LINE = /^(.+?)\s+Dated\s+(\S+)$/i;
// The status line of a number the tracker sends to an office instead of showing a status.
const CONTACT = /^CONTACT TO\b/i;
// An OUT row's route names the next office, then the one it left; an IN row's the office it came from, then the one it reached.
const OUT_ROUTE = /^Out To\s*(.*?)\s*From:\s*(.*)$/i;
const IN_ROUTE = /^From:\s*(.*?)\s*To:\s*(.*)$/i;
// A job code, as the first column prints it.
const JOB = /^[A-Z]{1,10}$/;
// The answer's key: the Base64 text the server encrypted the number into.
const KEY = /^[A-Za-z0-9+/]{2,200}={0,2}$/;
const DOC_LIST = /^\/Frm_DocList\.aspx$/i;
// The page the site sends a request it fails to, a blank error page.
const ERROR_PAGE = /^\/_NotAvailable\.aspx$/i;
// Bot checks a CDN or firewall could put in place of a page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|requested URL was rejected|_Incapsula_Resource|AwsWafIntegration|captcha-delivery/i;
// A run of nine or more digits, with spaces, brackets, dots or hyphens between them, as phone numbers are written.
const PHONE = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/g;
const FIELD = /^__[A-Z]{1,30}$/;
const MAX_FIELD_LENGTH = 50_000;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/** A Shree Mahavir consignment number: twelve digits. Anything else is not one its tracking form takes. */
export function normalizeMahavirNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shree Mahavir consignment numbers are twelve digits');
  return number;
}

/** Whether a page is a bot check instead of the carrier's own. */
export function isMahavirChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A page without what the carrier's own page has: a bot check, else a changed page. */
function unexpected(html: string, message: string): never {
  if (isMahavirChallenge(html)) throw new ChallengeError(PROVIDER, 'Shree Mahavir answered with a browser check');
  throw new SchemaError(PROVIDER, message);
}

/**
 * What the home page's tracking form posts back to look a number up, as its
 * Tracking button sends it. The other boxes of the form, the pickup request
 * with its captcha among them, are not part of a lookup and stay out.
 */
export function mahavirLookupFields(html: string, number: string): URLSearchParams {
  const $ = load(html);
  const form = $('form').filter((_, element) => $(element).find('input#txtAWBNo').length === 1);
  const button = form.find('input#cmdTrack[type="submit"]');
  if (form.length !== 1 || button.length !== 1) unexpected(html, 'Shree Mahavir returned a home page without its tracking form');
  const fields = new URLSearchParams();
  form.find('input[type="hidden"]').each((_, element) => {
    const name = $(element).attr('name') ?? '';
    const value = $(element).attr('value') ?? '';
    if (FIELD.test(name) && value.length <= MAX_FIELD_LENGTH) fields.set(name, value);
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(PROVIDER, 'Shree Mahavir returned a tracking form without its state');
  }
  fields.set('txtAWBNo', number);
  fields.set(button.attr('name') || 'cmdTrack', button.attr('value') || 'Tracking');
  return fields;
}

/** An address the site's redirect names, on its own host, or null for another. */
function siteAddress(location: string | null): URL | null {
  try {
    const target = location ? new URL(location, `${MAHAVIR_ORIGIN}/`) : null;
    return target?.origin === MAHAVIR_ORIGIN ? target : null;
  } catch {
    return null;
  }
}

/**
 * A page that answered with a redirect. The site sends a request it fails to
 * its blank error page, which is no answer; any other redirect is a moved route.
 */
export function mahavirRedirected(location: string | null, what: string): never {
  if (ERROR_PAGE.test(siteAddress(location)?.pathname ?? '')) {
    throw new IndeterminateError(PROVIDER, `Shree Mahavir sent its ${what} to its error page`);
  }
  throw new TransportError(PROVIDER, `Shree Mahavir moved its ${what}`);
}

/**
 * The tracking detail for the lookup's redirect. The post answers with the
 * address of the consignment list, whose frame opens the detail with the same
 * key; the key is Base64 the server writes raw, so it is encoded here to keep
 * a `+` from reaching the server as a space.
 */
export function mahavirDetailUrl(location: string | null): string {
  const target = siteAddress(location);
  if (!target || !DOC_LIST.test(target.pathname)) mahavirRedirected(location, 'tracking lookup');
  const raw = /[?&]docnos=([^&#]*)/i.exec(location!)?.[1] ?? '';
  let key = '';
  try {
    key = decodeURIComponent(raw);
  } catch {
    // A broken escape is a changed answer, as below.
  }
  if (!KEY.test(key)) throw new SchemaError(PROVIDER, 'Shree Mahavir answered the lookup without its key');
  return `${MAHAVIR_DETAIL}?docno=${encodeURIComponent(key)}`;
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

/** A field holding a day and a clock, as "20/08/26 - 06:29 PM". */
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

/** An event with its stage, from the carrier's code or wording. */
function staged(event: CarrierEvent, code: string | null): CarrierEvent {
  const stage = mahavirStage(code, String(event.description));
  return stage ? { ...event, stage: stage.stage, stage_source: stage.source } : event;
}

/**
 * One row of the transit details: the job, its day, the route and the clock.
 * An OUT row is worded as the status line words it, "Out To" the next office,
 * at the office it left; an IN row "Inward At" the office it reached.
 */
function projectJob($: CheerioAPI, row: Element): CarrierEvent {
  const cells = $(row).children('td');
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Shree Mahavir returned an incomplete scan');
  const job = clean(cells.eq(0).text(), 20).toUpperCase();
  if (!JOB.test(job)) throw new SchemaError(PROVIDER, 'Shree Mahavir returned a scan without its job');
  // The office names' tooltips hold their addresses and phone numbers; only the names are read.
  const route = clean(cells.eq(2).text(), 400);
  let description: string;
  let location = '';
  if (job === 'OUT' || job === 'IN') {
    const parts = (job === 'OUT' ? OUT_ROUTE : IN_ROUTE).exec(route);
    if (!parts) throw new SchemaError(PROVIDER, 'Shree Mahavir returned a scan with an invalid route');
    const [next, at] = job === 'OUT' ? [office(parts[1]), office(parts[2])] : ['', office(parts[2])];
    description = job === 'OUT' ? (next ? `Out To ${next}` : 'Out') : at ? `Inward At ${at}` : 'Inward';
    location = at;
  } else {
    // A job not seen yet keeps only its code: its route could name someone.
    description = job;
  }
  return staged({
    ...wallTime(clean(cells.eq(1).text(), 20), clean(cells.eq(3).text(), 20)),
    ...(location ? { location } : {}),
    description,
    provider_code: job,
  }, job);
}

/** One row of the delivery details: its day and clock, the delivering branch and the status. The receiver is not read. */
function projectDelivery($: CheerioAPI, row: Element): CarrierEvent {
  const cells = $(row).children('td');
  if (cells.length !== 4) throw new SchemaError(PROVIDER, 'Shree Mahavir returned an incomplete delivery');
  const description = clean(cells.eq(3).text().replace(PHONE, ''), 200);
  if (!description) throw new SchemaError(PROVIDER, 'Shree Mahavir returned a delivery without its status');
  const branch = office(cells.eq(1).text());
  return staged({ ...wallTimeOf(clean(cells.eq(0).text(), 60)), ...(branch ? { location: branch } : {}), description }, null);
}

/** The status line's own first line; an office's address and phone numbers can follow it, and are not read. */
function statusLine(element: Cheerio<Element>): string {
  const copy = element.clone();
  copy.find('br').replaceWith('\n');
  const [first = ''] = copy.text().split('\n').map((line) => clean(line, 300)).filter(Boolean);
  return clean(first.replace(PHONE, ''), 200);
}

const sameWording = (a: unknown, b: string) => clean(a, 200).toLowerCase() === b.toLowerCase();

/**
 * The tracking detail `Frm_DocTrack.aspx` shows for one encrypted number: the
 * booking (from and to centers, day and clock, consignee), a status line, the
 * transit jobs and the delivery rows, oldest first. A number the tracker holds
 * nothing for gets the same page with the number and every field empty. Some
 * numbers show only their booking office and a status line, or an office to
 * contact in place of a status and no tables. The page must name the number
 * asked. The consignee is kept; the destination, the delivery's receiver and
 * the offices' addresses and phone numbers are not.
 */
export function parseMahavir(html: string, raw: string): CarrierResult {
  const number = normalizeMahavirNumber(raw);
  const $ = load(html);
  const shown = $('span#lblDocNumber');
  const status = $('span#lblStatus');
  const fields = ['#txtFromCenter', '#txtToCenter', '#txtDate', '#txtReceiver'].map((id) => $(`span${id}`));
  const track = $('table#tblTrack');
  const delivery = $('table#tblDelivery');
  if (shown.length !== 1 || status.length !== 1 || fields.some((field) => field.length !== 1) || track.length > 1 || delivery.length > 1) {
    unexpected(html, 'Shree Mahavir returned a page without its tracking detail');
  }
  if (normalizeTrackingNumber(clean(shown.text(), 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Shree Mahavir answered for another consignment');
  }

  const [from, to, booked, consignee] = fields.map((field) => clean(field.text(), 200)) as [string, string, string, string];
  const line = statusLine(status);
  const jobs = dataRows($, track);
  const deliveries = dataRows($, delivery);
  const tables = track.length === 1 && delivery.length === 1;
  if (!from && !to && !booked && !consignee && !line && !jobs.length && !deliveries.length) {
    // The page for a number without a booking keeps both tables, with their headers alone.
    if (tables) throw new NotFoundError(PROVIDER);
    unexpected(html, 'Shree Mahavir returned an empty page without its tables');
  }
  if (!tables && !line) unexpected(html, 'Shree Mahavir returned a page without its tables');
  if (jobs.length + deliveries.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Shree Mahavir returned an oversized history');

  const fromOffice = office(from);
  const listed: CarrierEvent[] = [
    ...(booked ? [staged({
      ...wallTimeOf(booked), ...(fromOffice ? { location: fromOffice } : {}), description: fromOffice ? `Booked By ${fromOffice}` : 'Booked',
    }, null)] : []),
    ...jobs.map((row) => projectJob($, row)),
    ...deliveries.map((row) => projectDelivery($, row)),
  ];
  const seen = new Set<string>();
  const unique = listed.filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // The page lists the booking, then the jobs and the deliveries, oldest first. A row with a day
  // alone, or no readable day, keeps the place of the row before it on the same day.
  let previous = '';
  const keyed = unique.map((event) => {
    const local = typeof event.local_time === 'string' ? event.local_time : '';
    const key = !local || (local.length === 10 && previous.startsWith(local)) ? previous : local;
    previous = key;
    return { event, key };
  });
  // Newest first; rows that share a time keep their order.
  const ordered = [...keyed].reverse().sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? 1 : -1));
  const events = ordered.map(({ event }) => event);

  // The status line repeats the newest job, or names a step the tables do not show yet. An office
  // to contact is no status, and a line older than the newest scan is not the current one.
  const dated = STATUS_LINE.exec(line);
  const wording = dated ? clean(dated[1], 120) : line;
  const lineDay = dated ? localDay(dated[2]!) : null;
  const newestDay = ordered[0]?.key.slice(0, 10) ?? '';
  const current = Boolean(line) && !CONTACT.test(line) && !(lineDay && newestDay && lineDay < newestDay);
  if (current && lineDay && !events.some((event) => sameWording(event.description, wording)
    && String(event.local_time ?? '').startsWith(lineDay))) {
    events.unshift(staged({ local_time: lineDay, description: wording }, null));
  }

  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Shree Mahavir lists the consignment without a dated scan', { reason: 'listed' });
  const summed = current ? mahavirStage(null, wording) : null;
  const latest = events.find((event) => event.stage);
  const stage = summed?.stage ?? (latest?.stage as Stage | undefined);
  const source = summed?.source ?? latest?.stage_source;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(source) } : {}),
    last_status_text: current ? line : String(newest.description),
    last_update: null,
    ...(typeof newest.local_time === 'string' ? { last_update_local: newest.local_time } : {}),
    expected_delivery: null,
    timezone: ZONE,
    ...(/\p{L}/u.test(consignee) ? { receiver_name: consignee } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
