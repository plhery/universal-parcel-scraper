import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { eclStage, statusMap } from './status.js';

export const PROVIDER = 'xpress-courier-link';
/** ECL's tracking page, which reads the service and the number from its address and answers on its server. */
export const ECL_TRACKER = 'https://xpresscourierlink.com/tracking/';
// The whole page with a shipment is about 65 kB.
export const ECL_MAX_BYTES = 1024 * 1024;

/** The tracker's two services, as its form names them. */
export type EclService = 'International' | 'Domestic';

// The page takes any number and ECL publishes no layout; the numbers seen are digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
// A firewall's, CDN's or bot check's page in place of the tracking page. Every real page carries a
// hidden "imunify-bot-check" trap link, which is not a check.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden|Captcha)|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|imunify360|bot-protection|Checking your browser|Please wait while your request is being verified/i;
const NO_SHIPMENT = /^No shipment found$/i;
// "Wednesday, September 03 2025" and "09:31"
const DAY = /^(?:[A-Za-z]+,\s*)?([A-Za-z]+) (\d{1,2}),? (\d{4})$/;
const MINUTE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ROUTE = /^(.+?)\s*(?:→|->|&rarr;)\s*(.+)$/;
const MAX_EVENTS = 300;

/** A number for ECL's tracking page: letters and digits with at least one digit, in capitals. */
export function normalizeEclNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'ECL tracks numbers of 5 to 30 letters and digits');
  return number;
}

/** The tracking page's address for one number under one service, as its links carry them. */
export function eclTrackingUrl(raw: string, service: EclService = 'International'): string {
  return `${ECL_TRACKER}?${new URLSearchParams({ txtstatus: service, search: normalizeEclNumber(raw) }).toString()}`;
}

/** Whether a reply is a block page instead of ECL's tracking page. */
export function isEclBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 128_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function text($: CheerioAPI, element: Cheerio<AnyNode> | AnyNode, maxLength = 300): string {
  return clean($(element).text(), maxLength);
}

/** A scan's day heading and 24-hour clock as one wall clock. The page names no zone. */
function wallClock(day: string, minute: string): string {
  const date = DAY.exec(day);
  const clock = MINUTE.exec(minute);
  const month = date ? MONTHS.indexOf(date[1]!.toLowerCase()) + 1 : 0;
  const valid = date && month ? calendarDay(Number(date[3]), month, Number(date[2])) : null;
  if (!valid || valid < '2000-01-01' || !clock) return invalid('ECL returned an invalid scan time');
  return `${valid}T${clock[1]}:${clock[2]}:00`;
}

/** The value under one of the summary's headings. */
function summary($: CheerioAPI, card: Cheerio<AnyNode>, heading: string): string | undefined {
  const group = card.find('.info-group, .progress-info').toArray()
    .find((element) => text($, $(element).children('h3').first(), 60).toLowerCase() === heading);
  return group ? text($, $(group).children('p').first(), 200) : undefined;
}

/** The country at the end of the route, such as "DUBAI-UNITED ARAB EMIRATES". */
function destinationCountry(route: string | undefined): string | null {
  const to = route ? ROUTE.exec(route)?.[2] : undefined;
  if (!to) return null;
  const parts = to.split('-');
  for (let index = 0; index < parts.length; index += 1) {
    const country = countryCode(parts.slice(index).join(' ').trim()) ?? countryCode(parts.slice(index).join('-').trim());
    if (country) return country;
  }
  return null;
}

/**
 * The timeline's scans. Each day heading is followed by that day's scans, each with a clock, a
 * wording and a place.
 */
function scans($: CheerioAPI, timeline: Cheerio<AnyNode>): CarrierEvent[] {
  let day: string | null = null;
  const seen = new Set<string>();
  const events: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, element] of timeline.children().toArray().entries()) {
    const node = $(element);
    if (node.hasClass('timeline-date')) {
      day = text($, node, 60);
      continue;
    }
    if (!node.hasClass('timeline-item')) continue;
    if (day === null) return invalid('ECL returned a scan before its day');
    const local = wallClock(day, text($, node.find('.timeline-time').first(), 20));
    const description = text($, node.find('.timeline-title').first(), 200) || invalid('ECL returned a scan without its wording');
    const location = text($, node.find('.timeline-location').first(), 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = eclStage(description);
    events.push({ local, index, event: {
      local_time: local,
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
    if (events.length > MAX_EVENTS) return invalid('ECL returned too many scans');
  }
  // Newest first; of scans on one minute, the one higher on the page is the newer.
  events.sort((left, right) => right.local.localeCompare(left.local) || left.index - right.index);
  return events.map((scan) => scan.event);
}

/**
 * ECL's tracking page for `?txtstatus=<service>&search=<number>`. Its form repeats the service and
 * the number; under it, a shipment's card gives the number, the route, the booking date and the
 * current status, then a timeline of scans newest first under day headings. A number the service
 * does not know gets "No shipment found". The card also names the shipper and the consignee, which
 * are never read.
 */
export function parseEcl(page: string, raw: string, service: EclService): CarrierResult {
  const number = normalizeEclNumber(raw);
  const $ = load(page);
  const results = $('section.tracking-results');
  const form = $('form.tracking-form');
  if (results.length !== 1 || form.length !== 1) {
    if (isEclBlocked(page)) throw new ChallengeError(PROVIDER, 'ECL answered with a bot check');
    return invalid('ECL answered with a page that is not its tracking page');
  }
  // The page must be the one for the number and service asked.
  const echoed = normalizeTrackingNumber(String(form.find('input[name="search"]').first().val() ?? '').slice(0, 80)).toUpperCase();
  const selected = text($, form.find('select[name="txtstatus"] option[selected]').first(), 40);
  if (echoed !== number || selected !== service) throw new IndeterminateError(PROVIDER, 'ECL answered for another number or service');
  const cards = results.find('.summary-card');
  if (!cards.length) {
    if (results.find('.no-results-card h3').toArray().some((element) => NO_SHIPMENT.test(text($, element)))) {
      throw new NotFoundError(PROVIDER, `ECL's ${service.toLowerCase()} tracker has no shipment under this number`);
    }
    return invalid('ECL returned neither a shipment nor its not-found answer');
  }
  if (cards.length > 1) throw new IndeterminateError(PROVIDER, 'ECL answered for several shipments');
  const card = cards.first();
  const shown = summary($, card, 'tracking number');
  if (shown === undefined) return invalid('ECL returned a shipment without its tracking number');
  if (normalizeTrackingNumber(shown).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'ECL answered for another number');
  const timelines = results.find('.timeline');
  if (timelines.length > 1) return invalid('ECL returned several timelines');
  const events = timelines.length ? scans($, timelines.first()) : [];
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const country = destinationCountry(summary($, card, 'route'));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}
