import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { unipostStage } from './status.js';

export const PROVIDER = 'Unipost-Express';
const ORIGIN = 'https://www.unipost.md';
/** The page the home page's tracking form posts a waybill to. A plain GET of it is the site's 404. */
export const unipostTrackingUrl = (number: string): string => `${ORIGIN}/ru/track/${number}`;
export const UNIPOST_REFERER = `${ORIGIN}/ru`;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|sgcaptcha|captcha-delivery\.com/i;
// The waybill's heading: the form's fixed 373 label, a hyphen and the number typed.
const WAYBILL = /<strong>\s*373-(\d{1,15})\s*<\/strong>/g;
// The recipient's line ends with the destination's code and country, after the recipient's name.
const RECIPIENT = /<p class='left'>Получатель:<\/p><p class='right'>[^<]*,\s*[A-Z]{3}\/([A-Z]{2})\s*<\/p>/;
const WEIGHT = /<p class='left'>Вес, кг:<\/p><p class='right'>\s*(\d{1,5}(?:\.\d{1,3})?)\s*<\/p>/;
const NOTICE = /<div class='track_notice'>\s*Почтовой накладной с (\S{1,40}) номером не существует\.?\s*<\/div>/;
const ROW = /<tr\s+class='this_form_history'>([\s\S]*?)<\/tr>/g;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/;
// A place written as a three-letter city or airport code and a country: "LED/RU".
const CODED_PLACE = /^([A-Z]{3})\/([A-Z]{2})$/;

/**
 * Unipost-Express waybills are the digits typed after the tracking form's fixed `373` label, as
 * the reply prints them after it: "373-1001419" is the waybill `1001419`.
 */
export function normalizeUnipostNumber(raw: string): string {
  const text = typeof raw === 'string' && raw.length <= 64 ? raw.trim() : '';
  const number = /^373\s*-\s*(\d+)$/.exec(text)?.[1] ?? text.replace(/\s+/g, '');
  if (!/^\d{6,15}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Unipost-Express waybills are the digits after the 373 label');
  return number;
}

/** A row's clock, which the page gives with no zone; midnight is a row dated by its day alone. */
function clockOf(text: string): string {
  const match = CLOCK.exec(text);
  const date = match ? calendarDay(+match[1]!, +match[2]!, +match[3]!) : null;
  if (!match || !date) throw new SchemaError(PROVIDER, 'Unipost-Express returned an invalid scan time');
  return match[4] === '00:00:00' ? date : `${date}T${match[4]}`;
}

/** A row's place, with its code and country set apart so a reader can place the code: "LED, RU". */
function placeOf(text: string): string | undefined {
  const coded = CODED_PLACE.exec(text);
  return coded ? `${coded[1]}, ${coded[2]}` : text || undefined;
}

/**
 * The page for one waybill: its heading with the number, the sender, the recipient, pieces,
 * weight and type, then the history newest first. The heading and every row must name the whole
 * number asked; a notice that the waybill does not exist, naming that number, is one Unipost
 * does not know. The sender's and recipient's names and the comment column, which names who
 * signed, are never read.
 */
export function parseUnipost(html: string, raw: string): CarrierResult {
  const number = normalizeUnipostNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Unipost-Express returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Unipost-Express answered with a browser check');
  const start = html.indexOf('class="profile_track_title"');
  if (start < 0) throw new SchemaError(PROVIDER, 'Unipost-Express returned a page without its tracking results');
  const block = html.slice(start, start + 200_000);
  const notice = NOTICE.exec(block);
  if (notice) {
    if (notice[1] !== number) throw new SchemaError(PROVIDER, 'Unipost-Express answered about another waybill');
    throw new NotFoundError(PROVIDER);
  }
  const waybills = [...block.matchAll(WAYBILL)].map(match => match[1]);
  if (waybills.length !== 1 || waybills[0] !== number) throw new SchemaError(PROVIDER, 'Unipost-Express returned another waybill');
  const tableStart = block.indexOf("<table class='history'>");
  const tableEnd = block.indexOf('</table>', tableStart);
  if (tableStart < 0 || tableEnd < 0) throw new SchemaError(PROVIDER, 'Unipost-Express returned a waybill without its history');
  const table = block.slice(tableStart, tableEnd);
  const rows = [...table.matchAll(ROW)];
  if (rows.length > 300 || rows.length !== (table.match(/<tr\b/g)?.length ?? 0) - 1) {
    throw new SchemaError(PROVIDER, 'Unipost-Express returned an invalid history row');
  }
  const events: CarrierEvent[] = [];
  for (const [, row] of rows) {
    const cells = [...row!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => textFromHtml(cell[1], 300));
    if (cells.length !== 5) throw new SchemaError(PROVIDER, 'Unipost-Express returned an invalid history row');
    const [waybill, place, clock, description] = cells as [string, string, string, string];
    if (waybill !== number) throw new SchemaError(PROVIDER, 'Unipost-Express returned a row of another waybill');
    if (!description) continue;
    // Every row carries the destination's code, the first scans included, so only the delivery is placed there.
    const stage = unipostStage(description), location = stage === 'delivered' ? placeOf(place) : undefined;
    events.push({ local_time: clockOf(clock), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  // A waybill on file before its first scan.
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Unipost-Express lists the waybill without a scan', { reason: 'listed' });
  const newest = events[0]!;
  const stage = newest.stage as ReturnType<typeof unipostStage>;
  const destination = RECIPIENT.exec(block)?.[1];
  const weight = Number(WEIGHT.exec(block)?.[1]);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    ...(destination ? { destination_country: destination } : {}), ...(weight > 0 ? { weight_kg: weight } : {}), events };
}
