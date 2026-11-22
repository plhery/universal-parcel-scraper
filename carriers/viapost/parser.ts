import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { viapostStage } from './status.js';

export const PROVIDER = 'Viapost';
export const VIAPOST_MAX_BYTES = 1_000_000;
const MAX_EVENTS = 300;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
// The site's generic error page: its layout around the MVC template's "Error." heading. The tracker answers an
// order it does not know with it, under HTTP 500.
const ERROR_PAGE = /<title>Via Post<\/title>[\s\S]*<hgroup>\s*<h1>Error\.<\/h1>\s*<h2>An error occurred while processing your request\.<\/h2>\s*<\/hgroup>/;
// "4/2/2025 5:43:46 PM": month, day and hour without their leading zero, on Skopje's clock.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d):([0-5]\d) ([AP]M)$/;
// Viapost's own order ids, the UPU S10 numbers of the Magyar Posta parcels it delivers, and its VIA references.
const NUMBER = /^(?:\d{4,12}|[A-Z]{2}\d{9}[A-Z]{2}|VIA\d{6,24})$/;

/** Viapost's order ids, the postal S10 numbers of parcels it delivers last-mile, and its VIA references. */
export function normalizeViapostNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Viapost numbers are its order ids or the postal numbers of parcels it delivers');
  return number;
}

/** The tracking page of one order, which the tracking box on viapost.com.mk opens. */
export const viapostTrackingUrl = (raw: string): string =>
  `https://www.viapost.solutions/Order/Track/${encodeURIComponent(normalizeViapostNumber(raw))}`;

/** Whether a page is the site's generic error page, the tracker's answer under HTTP 500 for an order it does not know. */
export const isViapostErrorPage = (html: string): boolean => ERROR_PAGE.test(html) && !html.includes('new-tracking-event-list');

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const [, month, day, year, hour, minute, second, half] = match ?? [];
  const date = match ? calendarDay(Number(year), Number(month), Number(day)) : null;
  if (!date || Number(hour) < 1 || Number(hour) > 12) throw new SchemaError(PROVIDER, 'Viapost returned an invalid scan time');
  return `${date}T${String((Number(hour) % 12) + (half === 'PM' ? 12 : 0)).padStart(2, '0')}:${minute}:${second}`;
}

/**
 * The tracking page of one order: its number, the recipient's name, phone and address, the cash to
 * collect, the sender, then the history oldest first. Each scan reads "<status> - <account>", the
 * account being the sender for a new order and otherwise the courier or depot that recorded it, with
 * an optional comment. Only the status and its time are read: the recipient, the sender, the accounts
 * and the comments, which carry phone numbers, stay out. The order number must be the whole number asked.
 */
export function parseViapost(html: string, raw: string): CarrierResult {
  const number = normalizeViapostNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Viapost returned an empty page');
  if (html.length > VIAPOST_MAX_BYTES) throw new SchemaError(PROVIDER, 'Viapost returned an oversized page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Viapost answered with a browser check');
  const $ = load(html);
  const heading = /^НАРАЧКА\s*#\s*(\S{1,64})$/.exec(clean($('center b').first().text(), 200));
  if (!heading) throw new SchemaError(PROVIDER, 'Viapost returned a page without its order');
  if (heading[1]!.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Viapost returned another order');
  const rows = $('.new-tracking-event-list').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Viapost returned an oversized history');
  if (rows.length !== $('.public-type-name').length) throw new SchemaError(PROVIDER, 'Viapost returned an unreadable scan');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows) {
    const clock = clean($(row).children('div').first().text(), 40);
    const line = clean($(row).find('.public-type-name').text(), 300);
    // The status before the account that recorded it.
    const code = line.split(' - ')[0]!.trim();
    if (!code || code.length > 40) throw new SchemaError(PROVIDER, 'Viapost returned a scan without its status');
    const stage = viapostStage(code);
    const event: CarrierEvent = { local_time: wallClock(clock), description: code, provider_code: code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    // A scan repeats at the same second with the notice sent to the recipient, which is not read.
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Viapost lists the order without a scan', { reason: 'listed' });
  events.reverse();
  const newest = events[0]!;
  const stage = newest.stage as ReturnType<typeof viapostStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null, events };
}
