import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { afimexStage, statusMap } from './status.js';

export const PROVIDER = 'afimex';
/** The tracking page, which opens a session and carries the form's CSRF token. */
export const AFIMEX_PAGE = 'https://afimex.net/rastrea-envio';
/** Where the page's form posts the guides typed in, one per line. */
export const AFIMEX_RESULTS = 'https://afimex.net/rastrea-envio-resultado-v2';
// The page is about 40 kB, and a delivered parcel's results about 70 kB, most of it a signature.
export const AFIMEX_MAX_BYTES = 1024 * 1024;

// The tracking code: the eight digits after the label's second hyphen, as the page's help says.
const NUMBER = /^\d{8}$/;
// The tracker's answer for a guide it holds nothing for: "Sin Datos", last updated on 1 January of year 1.
const NO_DATA = /^sin datos$/i;
// A firewall's, CDN's or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|hcaptcha/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MAX_SCANS = 300;

/** An Afimex tracking code: eight digits. */
export function normalizeAfimexNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Afimex tracking codes are eight digits');
  return number;
}

/** Whether a page is a block page instead of Afimex's own. */
export function isAfimexBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** The form's CSRF token, which holds for the session the page opened. */
export function readAfimexToken(html: string): string {
  const $ = load(html.slice(0, 256_000));
  const token = $('form[action$="/rastrea-envio-resultado-v2"] input[name="_token"]').first().attr('value') ?? '';
  if (/^[A-Za-z0-9]{20,100}$/.test(token)) return token;
  if (isAfimexBlocked(html)) throw new ChallengeError(PROVIDER, 'Afimex answered with a browser check');
  throw new SchemaError(PROVIDER, 'Afimex\'s tracking page has no form token');
}

const text = (node: Cheerio<AnyNode>, max = 200): string => clean(node.text(), max);

/** The page's card for the guide asked, in its first view: the guide and its status line. */
function card($: CheerioAPI, number: string): Cheerio<AnyNode> | undefined {
  const cards = $('#guias .card-header');
  if (!cards.length) {
    if (isAfimexBlocked($.html())) throw new ChallengeError(PROVIDER, 'Afimex answered with a browser check');
    throw new SchemaError(PROVIDER, 'Afimex returned a page without tracking results');
  }
  const named = cards.filter((_, node) => normalizeTrackingNumber(text($(node).find('p.orange').first(), 64)) === number);
  return named.length ? named.first() : undefined;
}

/** The status the card states: the text before its "Ultima actualización" line. */
function statusLine(header: Cheerio<AnyNode>): string {
  const span = header.find('p.bold span').first();
  return clean(span.contents().first().text(), 120);
}

/** A scan's wall clock from its day's label and its own time. The page names no zone. */
function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const calendar = date && Number(date[1]) >= 2000 ? calendarDay(Number(date[1]), Number(date[2]), Number(date[3])) : null;
  if (!calendar || !clock) throw new SchemaError(PROVIDER, 'Afimex returned an invalid scan time');
  return `${calendar}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}`;
}

/**
 * The scans of the page's timeline view for the guide asked, newest first: each day's label, then
 * that day's scans, each with its time, its wording and the office. The proof of delivery, which
 * names the recipient and holds a signature, and the remarks, which name couriers and operators,
 * are never read.
 */
function scans($: CheerioAPI, number: string): CarrierEvent[] {
  const view = $('section#linea_de_tiempo').filter((_, node) => (
    normalizeTrackingNumber(text($(node).find('p.bold bold').first(), 64)) === number)).first();
  if (!view.length) throw new SchemaError(PROVIDER, 'Afimex returned results without the guide\'s timeline');
  const events: CarrierEvent[] = [];
  let day = '';
  for (const node of view.find('.timeline').first().children().toArray()) {
    const entry = $(node);
    if (entry.hasClass('time-label')) {
      day = text(entry, 20);
      continue;
    }
    const item = entry.children('.timeline-item').first();
    if (!item.length) continue;
    const description = text(item.find('.timeline-header bold').first(), 120);
    const time = text(item.children('.time').first(), 20);
    // The empty item the page draws for a guide without scans.
    if (!description && !time) continue;
    if (!description) throw new SchemaError(PROVIDER, 'Afimex returned a scan without its wording');
    const location = text(item.find('.timeline-body > .row > div').first(), 120);
    const staged = afimexStage(description);
    events.push({
      local_time: wallClock(day, time),
      description,
      ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
    if (events.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Afimex returned too many scans');
  }
  // Newest first, as the page lists them; an oldest-first list is turned round.
  return events.length > 1 && events[0]!.local_time! < events.at(-1)!.local_time! ? events.reverse() : events;
}

/**
 * The page `POST /rastrea-envio-resultado-v2` returns for one guide. Its first view holds a card
 * per guide with the guide, its status and the towns it travels between; its second, a timeline
 * of the guide's scans by day. A guide the tracker holds nothing for gets a card whose status is
 * "Sin Datos". The card must name the guide asked.
 */
export function parseAfimex(html: string, raw: string): CarrierResult {
  const number = normalizeAfimexNumber(raw);
  const $ = load(html);
  const header = card($, number);
  if (!header) throw new IndeterminateError(PROVIDER, 'Afimex answered for another guide');
  const status = statusLine(header);
  if (NO_DATA.test(status)) throw new NotFoundError(PROVIDER, 'Afimex has no data for this guide');
  const events = scans($, number);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Afimex lists the guide without scans');
  // The newest scan with a stage leads.
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
