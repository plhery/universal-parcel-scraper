import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { kongaStage, statusMap } from './status.js';

export const PROVIDER = 'konga-kxpress';
// A page is about fourteen kilobytes, most of it the site's menus and an illustration.
export const KONGA_MAX_BYTES = 512 * 1024;

// F and twelve digits: a seller's shipment, the order's nine digits and a line number. R and nine
// digits: the order. KEXP and sixteen hexadecimal characters: a Konga Logistics waybill.
const NUMBER = /^(?:F\d{12}|R\d{9}|KEXP[0-9A-F]{16})$/;
// Bot checks a CDN or firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied)|g-recaptcha|h-captcha/i;
// The tracker's only wording for a number it does not know, under the number it echoes.
const NOT_FOUND = 'We could not find this tracking number.';
// "Sat, Jun 03, 2023, 04:08 PM": a wall clock without a zone.
const CLOCK = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):([0-5]\d) ([AP]M)$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The facility and town a row names: where the parcel arrived, was received or was created, or the one it left.
const PLACES = [/^Order has arrived at (.+)$/i, /^Order has left (.+?) to .+$/i, /^Shipment received at (.+)$/i, /^Shipment Created (.+)$/i];
const MAX_ROWS = 300;

/** A Konga Logistics number: F and twelve digits, R and nine digits, or KEXP and sixteen hexadecimal characters. */
export function normalizeKongaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Konga Logistics numbers are F and twelve digits, R and nine digits, or KEXP and sixteen hexadecimal characters');
  }
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * A row's clock as its wall time, which the page gives without a zone; text that does not read as
 * one, or names a weekday its date does not fall on, stays as the carrier wrote it.
 */
export function kongaClock(text: string): { local_time?: string; provider_time_text?: string } {
  const match = CLOCK.exec(text);
  const day = match ? calendarDay(Number(match[4]), MONTHS.indexOf(match[2]!) + 1, Number(match[3])) : null;
  const hour = match ? Number(match[5]) : 0;
  if (!match || !day || hour < 1 || hour > 12 || WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] !== match[1]) {
    return text ? { provider_time_text: text } : {};
  }
  // 12 AM is midnight and 12 PM noon.
  const hours = (hour % 12) + (match[7] === 'PM' ? 12 : 0);
  return { local_time: `${day}T${String(hours).padStart(2, '0')}:${match[6]}:00` };
}

/** The place a row's sentence names, when it is one of the sentences that name one. */
function placeOf(description: string): string | undefined {
  for (const pattern of PLACES) {
    const place = clean(pattern.exec(description)?.[1], 160);
    if (place) return place;
  }
  return undefined;
}

/** The number a page names, as the tracker echoes it. */
const echoed = ($: CheerioAPI, selector: string): string => normalizeTrackingNumber(clean($(selector).first().text(), 64));

/** The rows of `ul#order-tree`, newest first: their bold wording and their clock. */
function eventsOf($: CheerioAPI): CarrierEvent[] {
  const tree = $('ul#order-tree');
  if (tree.length !== 1) return invalid('Konga Logistics returned a page without its history');
  const items = tree.children().toArray();
  if (items.length > MAX_ROWS) return invalid('Konga Logistics returned too many rows');
  // The tracker names the shipment and has no scan for it yet.
  if (items.length === 0) throw new NoHistoryError(PROVIDER, 'Konga Logistics lists the shipment without a scan', { reason: 'listed' });

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const node of items) {
    const item = $(node);
    const label = item.children('b');
    const clock = item.children('p');
    if (!item.is('li') || label.length !== 1 || clock.length > 1) return invalid('Konga Logistics returned an unreadable row');
    const description = clean(label.text(), 300);
    if (!description) return invalid('Konga Logistics returned a row without its wording');
    const when = kongaClock(clean(clock.text(), 64));
    const key = JSON.stringify([when.local_time ?? when.provider_time_text ?? '', description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const location = placeOf(description);
    const staged = kongaStage(description);
    events.push({ ...when, description, ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Newest first, as the page lists them. The sort is stable, so rows of one minute keep the page's
  // order, and a row without a clock stays under the row above it.
  let above = '9999-12-31T23:59:59';
  const keyed = events.map((event) => {
    above = event.local_time ?? above;
    return { event, key: above };
  });
  return keyed.sort((left, right) => (left.key < right.key ? 1 : left.key > right.key ? -1 : 0)).map(({ event }) => event);
}

/**
 * Reads Konga Logistics's tracking page for one number. A shipment the tracker knows is named
 * under "Package Number", with a status tag and its rows newest first, each a sentence over its
 * wall clock. A number it does not know gets a page that echoes it over "We could not find this
 * tracking number."
 */
export function parseKonga(html: string, number: string): CarrierResult {
  const $ = load(html);
  const found = $('b#order');
  const missing = $('h5#order-num');
  if (found.length + missing.length === 0) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Konga Logistics returned a verification page');
    return invalid('Konga Logistics returned a page without a tracking number');
  }
  if (found.length + missing.length > 1) return invalid('Konga Logistics returned an unreadable page');

  if (missing.length) {
    if (echoed($, 'h5#order-num') !== number) throw new IndeterminateError(PROVIDER, 'Konga Logistics answered for another number');
    const notices = $('.error-msg p').toArray().map((node) => clean($(node).text(), 200));
    if (notices.includes(NOT_FOUND)) throw new NotFoundError(PROVIDER, 'Konga Logistics could not find this tracking number');
    return invalid('Konga Logistics returned an error page');
  }

  if (echoed($, 'b#order') !== number) throw new IndeterminateError(PROVIDER, 'Konga Logistics answered for another number');
  const echoes = $('span.track-no').toArray().map((node) => normalizeTrackingNumber(clean($(node).text(), 64)));
  if (echoes.some((echo) => echo !== number)) return invalid('Konga Logistics named two numbers on one page');
  const events = eventsOf($);

  // The rows decide; the tag over them only when none has a stage.
  const lead = leadingScan(events, statusMap);
  const label = lead ? '' : clean($('.tag-bar button.tag').first().text(), 80);
  const tag = label ? kongaStage(label) : null;
  const stage = (lead?.stage ?? tag?.stage) as Stage | undefined;
  const source = lead ? lead.stage_source ?? 'carrier_map' : tag?.source;
  const newest = events.find((event) => event.local_time);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source! } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    expected_delivery: null,
    events,
  };
}
