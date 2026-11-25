import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { ctmStage, statusMap } from './status.js';

export const PROVIDER = 'ctm-messagerie';
/** CTM Messagerie's tracking page, which takes `ndesuivi=<number>` as a form post and answers in place. */
export const CTM_LOOKUP = 'https://ctm-messagerie.ma/fr/suivi-du-colis';
// The whole page is about 40 kB.
export const CTM_MAX_BYTES = 1024 * 1024;

// The receipt numbers seen are digits; the form takes any text. Every number has a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,20}$/;
// A firewall's, CDN's or bot check's page in place of the tracking page.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The result section of the tracking page.
const SECTION = /<section class="section page_suivi_colis">([\s\S]*?)<\/section>/;
// The page's own answer for a number it holds no parcel under.
const NOT_FOUND = /<div class="alert alert-danger">\s*<p>\s*Aucun colis ne correspond à vos critères de recherche\./;
const DETAIL = /<div class="detail_suivi_colis">/;
// One header field: its label and its value.
const FIELD = /<label>\s*<span class="icon_[a-z]+"><\/span>([\s\S]*?)<\/label>\s*<p[^>]*>([\s\S]*?)<\/p>/g;
// One history row: its wall clock, its status and its agency.
const ROW = /<div class="row row_[a-z_]+">([\s\S]*?)(?=<div class="row row_|$)/g;
const CELL = /<p>([\s\S]*?)<\/p>/g;
// "17/08/2024 10:42": a row's wall clock in Morocco, without a zone.
const WALL_CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ROWS = 200;

/** A number for CTM's tracker: letters and digits with at least one digit, in capitals. */
export function normalizeCtmNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'CTM Messagerie tracks receipt numbers of 5 to 20 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracking page. */
export function isCtmBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(value: string): string {
  const parts = WALL_CLOCK.exec(value);
  const day = parts && calendarDay(Number(parts[3]), Number(parts[2]), Number(parts[1]));
  if (!parts || !day || Number(parts[3]) < 2000) return invalid('CTM Messagerie returned an invalid date');
  return `${day}T${parts[4]}:${parts[5]}:00`;
}

/** One history row: its wall clock, its status and the agency that wrote it. */
function row(block: string): CarrierEvent {
  const cells = [...block.matchAll(CELL)].map(([, value]) => textFromHtml(value, 200));
  if (cells.length < 2) return invalid('CTM Messagerie returned an invalid history row');
  const [time, description, location] = cells as [string, string, string | undefined];
  if (!description) return invalid('CTM Messagerie returned a history row without its status');
  const staged = ctmStage(description);
  return {
    local_time: wallClock(time),
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The tracking page CTM Messagerie answers `POST /fr/suivi-du-colis` with. A parcel's result
 * section has a header with the receipt number, the date of dispatch, the recipient's name and
 * town, and a history of rows, newest first, each with its wall clock in Morocco, its status
 * and the agency that wrote it. A number it holds no parcel under gets an alert instead.
 *
 * The recipient's name is never read. The page's commented-out sample rows are not history.
 */
export function parseCtm(body: string, raw: string): CarrierResult {
  const number = normalizeCtmNumber(raw);
  if (typeof body !== 'string') return invalid('CTM Messagerie returned an unexpected reply');
  const html = body.replace(/<!--[\s\S]*?-->/g, '');
  const section = SECTION.exec(html)?.[1];
  if (section === undefined) {
    if (isCtmBlocked(html)) throw new ChallengeError(PROVIDER, 'CTM Messagerie answered with a browser check');
    return invalid('CTM Messagerie returned a page without its tracking result');
  }
  if (!DETAIL.test(section)) {
    // The page's own answer for a number it holds no parcel under. It does not repeat the
    // number; the request for it does.
    if (NOT_FOUND.test(section)) throw new NotFoundError(PROVIDER, 'CTM Messagerie has no parcel under this number');
    return invalid('CTM Messagerie returned an unexpected tracking result');
  }
  const fields = new Map<string, string>();
  for (const [, label, value] of section.matchAll(FIELD)) fields.set(textFromHtml(label, 80).toLowerCase(), textFromHtml(value, 200));
  const echoed = fields.get('numéro du récépissé') ?? invalid('CTM Messagerie returned a result without its number');
  // The result must name the number asked.
  if (normalizeTrackingNumber(echoed).toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'CTM Messagerie answered for another parcel');
  const history = section.split('<div class="detail_suivi_colis-body">')[1] ?? '';
  const blocks = [...history.matchAll(ROW)].map(([, block]) => block ?? '');
  if (blocks.length > MAX_ROWS) return invalid('CTM Messagerie returned too many history rows');
  const events = blocks.map(row);
  const newest = events[0];
  if (!newest) return invalid('CTM Messagerie returned a parcel without history');
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
