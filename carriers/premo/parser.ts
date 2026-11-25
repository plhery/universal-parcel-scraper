import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { premoEventStage, statusMap } from './status.js';

export const PROVIDER = 'premo';
/** Premo's tracking page, which reads the number from its `id` parameter and lists the events in the page. */
export const PREMO_TRACKER = 'https://www.premo.se/paketsparning';
// The whole page with six events is about 31 kB.
export const PREMO_MAX_BYTES = 1024 * 1024;

// The page takes any number; the ones it answers are letters and digits. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracking page.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The tracking page's own markers: its body class and the search form, which repeats the number asked.
const PAGE = /<body[^>]*\bclass="[^"]*\bpage-packageTracking\b/;
const ECHO = /<input\b[^>]*\bname="id"[^>]*>/;
const VALUE = /\bvalue="([^"]*)"/;
// The page's answer for a number it holds no parcel under.
const NO_PACKAGE = /class="error-message error-message--no-package"/;
const ERROR = /class="error-message\b/;
const LIST = /<ul class="package-tracking-events__list">([\s\S]*?)<\/ul>/;
const ITEM = /<li class="package-tracking-events__list-item">([\s\S]*?)<\/li>/g;
const CODE = /<div class="package-tracking-event\b[^"]*"[^>]*\bdata-api-key="([^"]*)"/;
const HEADING = /<h3 class="package-tracking-event__heading">([\s\S]*?)<\/h3>/;
const DATE = /<p class="package-tracking-event__date">([\s\S]*?)<\/p>/;
// "måndag 2026-10-19 kl. 14:43": the weekday, the day and Stockholm's wall clock, without a zone.
const WALL_CLOCK = /^(?:[a-zåäö]+ )?(\d{4})-(\d{2})-(\d{2}) kl\. ?([01]\d|2[0-3])[:.]([0-5]\d)$/i;
const MAX_EVENTS = 200;
const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é',
};

/** A number for Premo's tracking page: letters and digits with at least one digit, in capitals. */
export function normalizePremoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Premo tracks numbers of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of Premo's tracking page. */
export function isPremoBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (!name.startsWith('#')) return NAMED[name] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** An HTML fragment's text. */
function text(fragment: string, max: number): string {
  return clean(decodeEntities(fragment.replace(/<[^>]*>/g, ' ')), max);
}

/** An event's wall clock, calendar-checked. The page names no zone. */
function wallClock(value: string): string {
  const parts = WALL_CLOCK.exec(value);
  const day = parts && calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]));
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('Premo returned an invalid event time');
  return `${day}T${parts[4]}:${parts[5]}:00`;
}

/**
 * One event: its code, its heading and its wall clock. The paragraphs under a heading are
 * Premo's fixed help text for the event, and are not read.
 */
function event(item: string): CarrierEvent {
  const heading = HEADING.exec(item);
  const date = DATE.exec(item);
  if (!heading || !date) return invalid('Premo returned an event without its heading or time');
  const description = text(heading[1]!, 200) || invalid('Premo returned an event without its heading');
  const raw = CODE.exec(item)?.[1];
  const code = raw === undefined || raw === '' ? null : /^\d{1,6}$/.test(raw) ? raw : invalid('Premo returned an invalid event code');
  const staged = premoEventStage(code, description);
  return {
    local_time: wallClock(text(date[1]!, 60)),
    description,
    ...(code === null ? {} : { provider_code: code }),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** Newest first, as the page lists them; an oldest-first list is turned round, ties kept in its order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  return events.length > 1 && (events[0]!.local_time as string) < (events.at(-1)!.local_time as string) ? events.reverse() : events;
}

/**
 * Premo's tracking page for `?id=<number>`, rendered on its server. It repeats the number in its
 * search form, then lists the parcel's events newest first, each with Premo's code, a Swedish
 * heading and a weekday, day and wall clock; for a number it holds no parcel under it shows
 * "Vi kunde inte hitta något paket" instead. A page with neither leaves the answer open.
 */
export function parsePremo(page: string, raw: string): CarrierResult {
  const number = normalizePremoNumber(raw);
  const form = ECHO.exec(page)?.[0];
  if (!PAGE.test(page) || !form) {
    if (isPremoBlocked(page)) throw new ChallengeError(PROVIDER, 'Premo answered with a browser check');
    return invalid('Premo answered with a page that is not its tracking page');
  }
  // The page must be the one for the number asked.
  const echoed = normalizeTrackingNumber(decodeEntities(VALUE.exec(form)?.[1] ?? ''));
  if (echoed !== number) throw new IndeterminateError(PROVIDER, 'Premo answered for another number');
  const list = LIST.exec(page)?.[1];
  if (list === undefined) {
    if (NO_PACKAGE.test(page)) throw new NotFoundError(PROVIDER, 'Premo has no parcel under this number');
    if (ERROR.test(page)) throw new IndeterminateError(PROVIDER, 'Premo did not complete the lookup');
    // Seen for parcels Premo's network knows but holds no event of its own for.
    throw new IndeterminateError(PROVIDER, 'Premo shows neither events nor its not-found answer for the number');
  }
  const items = [...list.matchAll(ITEM)].map((match) => match[1]!);
  if (!items.length) throw new IndeterminateError(PROVIDER, 'Premo lists no event for the parcel');
  if (items.length > MAX_EVENTS) return invalid('Premo returned too many events');
  const events = newestFirst(items.map(event));
  const newest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events,
  };
}
