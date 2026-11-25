import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { ozonStage, statusMap } from './status.js';

export const PROVIDER = 'ozon-express-ma';
/** The lookup Ozon Express's tracking box posts `tracking-number=<number>` to, as a multipart form. */
export const OZON_LOOKUP = 'https://api.ozonexpress.ma/customers/tracking-new';
// A delivered parcel with seven steps is about 12 kB, most of it the card's style sheet.
export const OZON_MAX_BYTES = 256 * 1024;

// Ozon's codes are letters and digits; a seller may choose its own. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's card.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The card the tracker answers a number it does not know with: "تتبع الطرد" (parcel tracking)
// over "هذا الرقم غير موجود" (this number does not exist).
const NOT_FOUND_TITLE = /<h2[^>]*>\s*تتبع الطرد\s*<\/h2>/;
const NOT_FOUND_TEXT = /<p[^>]*>\s*هذا الرقم غير موجود\s*<\/p>/;
// The card of a parcel it knows.
const CARD = /<div class="ctm-tracking-container">/;
// "28/06/2026 17:12": a step's wall clock in Morocco, without a zone.
const WALL_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
// One header field: its label and its value.
const FIELD = /<div class="ctm-info-content">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g;
const STEP_TITLE = /<div class="timeline-step-title[^"]*">([\s\S]*?)<\/div>/;
const STEP_DATE = /<div class="timeline-step-date">([\s\S]*?)<\/div>/;
const MAX_STEPS = 200;

/** A number for Ozon's tracker: letters and digits with at least one digit, in capitals. The tracker ignores case. */
export function normalizeOzonNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Ozon Express tracks codes of 6 to 40 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's card. */
export function isOzonBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A step's or the header's wall clock, calendar-checked, or nothing for an empty one. */
function wallClock(value: string): string | undefined {
  if (value === '') return undefined;
  const parts = WALL_CLOCK.exec(value);
  const day = parts && calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1]));
  if (!parts || !day || Number(parts[3]) < 2000) return invalid('Ozon Express returned an invalid date');
  return `${day}T${parts[4]}:${parts[5]}:00`;
}

/** The steps of the card's timeline, oldest first as it draws them; a step without a date is not an event. */
function steps(card: string): CarrierEvent[] {
  const blocks = card.split('<div class="timeline-step">').slice(1);
  if (blocks.length > MAX_STEPS) return invalid('Ozon Express returned too many steps');
  const events: CarrierEvent[] = [];
  for (const block of blocks) {
    const description = textFromHtml(STEP_TITLE.exec(block)?.[1] ?? '', 200);
    if (!description) return invalid('Ozon Express returned a step without its status');
    const time = wallClock(textFromHtml(STEP_DATE.exec(block)?.[1] ?? '', 40));
    if (!time) continue;
    const staged = ozonStage(description);
    // The timeline repeats a step at the same minute when it is recorded twice; it shows once.
    const last = events.at(-1);
    if (last && last.local_time === time && last.description === description) continue;
    events.push({ local_time: time, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  return events.reverse();
}

/**
 * The reply of `POST api.ozonexpress.ma/customers/tracking-new`, the lookup Ozon Express's
 * tracking box makes for each number: an HTML card whose header gives the number, the time of the
 * last update and the current status, over a timeline of the parcel's steps, oldest first, each
 * with its status and its wall clock in Morocco. A number the tracker does not know gets a short
 * card saying that the number does not exist.
 *
 * The timeline's markers and the payment state in its comments are not read: the markers do not
 * follow the steps, and the payment state is the seller's business.
 */
export function parseOzon(body: string, raw: string): CarrierResult {
  const number = normalizeOzonNumber(raw);
  if (typeof body !== 'string') return invalid('Ozon Express returned an unexpected reply');
  const html = body.replace(/<!--[\s\S]*?-->/g, '');
  if (!CARD.test(html)) {
    // The tracker's own answer for a number it does not know. It does not repeat the number;
    // the request for it does.
    if (NOT_FOUND_TITLE.test(html) && NOT_FOUND_TEXT.test(html)) throw new NotFoundError(PROVIDER, 'Ozon Express does not know this number');
    if (isOzonBlocked(html)) throw new ChallengeError(PROVIDER, 'Ozon Express answered with a browser check');
    return invalid('Ozon Express returned an unexpected reply');
  }
  const fields = new Map<string, string>();
  for (const [, label, value] of html.matchAll(FIELD)) fields.set(textFromHtml(label, 80).toLowerCase(), textFromHtml(value, 200));
  const echoed = fields.get('numéro du récépissé') ?? invalid('Ozon Express returned a card without its number');
  // The card must name the number asked; the tracker echoes it in the case it was sent.
  if (normalizeTrackingNumber(echoed).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Ozon Express answered for another parcel');
  const events = steps(html);
  const newest = events[0];
  if (!newest) {
    // A parcel without dated steps stands on the status the header shows, when it shows one.
    const current = fields.get('statut actuel') ?? '';
    const staged = current && current !== 'N/A' ? ozonStage(current) : null;
    if (!staged) throw new NoHistoryError(PROVIDER, 'Ozon Express lists the parcel without steps', { reason: 'listed' });
    const updated = wallClock(fields.get('dernière mise à jour') ?? '');
    return {
      status: languageStageStatus(staged.stage), current_stage: staged.stage, current_stage_source: staged.source,
      last_status_text: current, last_update: null, ...(updated ? { last_update_local: updated } : {}), expected_delivery: null,
      summary_only: true, events: [],
    };
  }
  // The newest step with a stage leads; a parcel whose steps all lack one keeps an open status.
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
