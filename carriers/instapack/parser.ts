import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { isText, type AnyNode } from 'domhandler';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { instapackStage, statusMap } from './status.js';

export const PROVIDER = 'instapack';
/** The tracking page instapack.es links to; its form posts `code` back to the same address. */
export const INSTAPACK_TRACKING = 'https://back.instapack.es/client-dashboard/seguimiento-de-envios/';
// A delivered parcel's page is about 20 kB, most of it the map's script.
export const INSTAPACK_MAX_BYTES = 512 * 1024;

// The tracker finds a parcel by the code the sender gave it, in any case: Instapack's own order
// ids and marketplace numbers. Every code seen has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// The parcel's page the form redirects to: a signed token naming the code, valid for a week.
const RESULT = /^(?:https:\/\/back\.instapack\.es)?(\/client-dashboard\/seguimiento-de-envios\/[\w-]{10,600}\.[\w-]{10,1200}\.[\w-]{10,200})$/;
// A firewall's, CDN's or bot check's page.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|captcha/i;
// The form's message for a code the tracker has no parcel under. It does not repeat the code.
const NOT_FOUND = /^No se localiza ningún paquete\.?$/i;
// The heading's label; the code follows it.
const LABEL = /^N[º°o]\.? de seguimiento:?$/i;
const CODE = /^[A-Za-z0-9-]{1,64}$/;
// "25/03/22 08:56 - Salida a reparto", a scan row, or "25/03/2022 10:58- Incidencias en entrega - Ausente", an incident's.
const ROW = /^(\d{2}\/\d{2}\/(?:\d{2}|\d{4}) \d{2}:\d{2})\s*-\s*(\S.{0,199})$/;
const STAMP = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
// A phone number or an email address, which a row must not pass on.
const PERSONAL = /\+?\d[\d .-]{6,}\d|\S+@\S+\.\S+/g;
const MAX_SCANS = 200;
// Later steps first among scans of one minute: the driver is assigned, then leaves on the round.
const ORDER: Partial<Record<Stage, number>> = { registered: 1, accepted: 2, in_transit: 3, out_for_delivery: 4, failed_attempt: 5, delivered: 6 };

/** A code for Instapack's tracker: letters and digits with at least one digit, in capitals. */
export function normalizeInstapackNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Instapack tracks codes of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's. */
export function isInstapackBlocked(html: string): boolean {
  return BLOCKED.test(html.slice(0, 64_000));
}

/** The path of the parcel's page the form's redirect names, or nothing when it names another. */
export function instapackResultPath(location: string | null): string | undefined {
  return location ? RESULT.exec(location.trim())?.[1] : undefined;
}

/**
 * The tracking form again, HTTP 200, for a code without a redirect: its message saying there is
 * no such parcel is not found. Any other message, or none, is not.
 */
export function parseInstapackRefusal(html: string): never {
  const $ = load(html);
  const message = clean($('#id_alert_body').first().text(), 200);
  if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER, 'Instapack has no parcel under this code');
  if (isInstapackBlocked(html)) throw new ChallengeError(PROVIDER, 'Instapack answered with a browser check');
  if (message) throw new IndeterminateError(PROVIDER, 'Instapack refused the lookup');
  if ($('form input[name="code"]').length) throw new SchemaError(PROVIDER, 'Instapack returned its form without an answer');
  throw new SchemaError(PROVIDER, 'Instapack returned an unexpected page');
}

/** A row's wall clock, calendar-checked; a two-digit year is this century's. */
function wallClock(stamp: string): string {
  const parts = STAMP.exec(stamp);
  const year = parts ? Number(parts[3]!.length === 2 ? `20${parts[3]}` : parts[3]) : 0;
  const day = parts && calendarDay(year, Number(parts[2]), Number(parts[1]));
  if (!parts || !day) throw new SchemaError(PROVIDER, 'Instapack returned an invalid scan time');
  return `${day}T${parts[4]}:${parts[5]}:00`;
}

function event(stamp: string, wording: string): CarrierEvent {
  const description = clean(wording.replace(PERSONAL, ' '), 200).replace(/[\s-]+$/, '');
  if (!description) throw new SchemaError(PROVIDER, 'Instapack returned a scan without its wording');
  const staged = instapackStage(description);
  return { local_time: wallClock(stamp), description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
}

/** A panel body's lines, as the page breaks them, each with its spaces collapsed. */
function lines(body: Cheerio<AnyNode>): string[] {
  return (body.html() ?? '').split(/<br\s*\/?>/i).map((part) => clean(load(part).text(), 400)).filter(Boolean);
}

/** The code a panel's heading names after its label, or nothing when the panel is not the heading's. */
function headingCode($: CheerioAPI, panel: Cheerio<AnyNode>): string | undefined {
  const label = panel.find('.panel-title strong').toArray().find((node) => LABEL.test(clean($(node).text(), 60)));
  if (!label) return undefined;
  const next = label.nextSibling;
  const code = next && isText(next) ? clean(next.data, 80) : '';
  if (!CODE.test(code)) throw new SchemaError(PROVIDER, 'Instapack returned a parcel without its code');
  return code;
}

/** Newest first; scans of one minute keep the later step first, else the page's order. */
function newestFirst(events: CarrierEvent[]): CarrierEvent[] {
  const rank = (scan: CarrierEvent) => ORDER[scan.stage as Stage] ?? 0;
  return events.map((scan, index) => ({ scan, index }))
    .sort((a, b) => (b.scan.local_time as string).localeCompare(a.scan.local_time as string) || rank(b.scan) - rank(a.scan) || a.index - b.index)
    .map(({ scan }) => scan);
}

/**
 * The parcel's page, which the form redirects to for a code the tracker knows. A heading panel
 * names the code; then a panel lists the driver's steps, `dd/mm/yy HH:MM - <step>`, under a title
 * naming the driver and their phone; a panel lists the delivery incidents, `dd/mm/yyyy HH:MM-
 * <type> - <reason>`; and a delivered parcel's last panel is titled with the delivery's time and
 * wording over the delivery address. Times are wall clocks without a zone.
 *
 * The delivery address, the driver's name and phone, the parcel count, the sender's references
 * and the map's coordinates are never read.
 */
export function parseInstapack(html: string, raw: string): CarrierResult {
  const number = normalizeInstapackNumber(raw);
  const $ = load(html);
  const panels = $('article.panel').toArray().map((node) => $(node));
  const headings = panels.map((panel) => headingCode($, panel));
  const heading = headings.find(Boolean);
  if (!heading) {
    if (isInstapackBlocked(html)) throw new ChallengeError(PROVIDER, 'Instapack answered with a browser check');
    throw new SchemaError(PROVIDER, 'Instapack returned an unexpected page');
  }
  // The page must name the code asked.
  if (normalizeTrackingNumber(heading).toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Instapack answered for a different parcel');
  const events: CarrierEvent[] = [];
  for (const [index, panel] of panels.entries()) {
    // The heading's body is the delivery address, the parcel count and the sender's references.
    if (headings[index]) continue;
    const title = panel.find('.panel-title').first();
    const stamp = clean(title.find('span').first().text(), 40);
    if (STAMP.test(stamp)) {
      // A dated title, the delivery's: its body is the delivery address.
      events.push(event(stamp, title.find('strong').first().text()));
      continue;
    }
    // The title names the driver or counts the incidents; only the body's dated rows are read.
    for (const line of lines(panel.find('.panel-body').first())) {
      const row = ROW.exec(line);
      if (row) events.push(event(row[1]!, row[2]!));
    }
  }
  if (events.length > MAX_SCANS) throw new SchemaError(PROVIDER, 'Instapack returned too many scans');
  const ordered = newestFirst(events);
  const newest = ordered[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Instapack lists the parcel without scans', { reason: 'listed' });
  const lead = leadingScan(ordered, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    events: ordered,
  };
}
