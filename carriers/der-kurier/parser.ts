import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { derKurierStage, statusMap } from './status.js';

export const PROVIDER = 'der-kurier';
// A parcel's page is about ten kilobytes; one that reuses its number for years, a few more.
export const DER_KURIER_MAX_BYTES = 512 * 1024;

// Eleven digits, or the label's twelve, whose last is a check digit the tracker does not take.
const NUMBER = /^(\d{11})\d?$/;
// Bot checks a CDN or a cloud firewall could put in place of the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|awswaf|<title>\s*(?:Just a moment|Attention Required|Access denied|Request Rejected)/i;
// The page posts its form back to itself under the number it was asked.
const ECHO = /<form\b[^>]*\baction="\.\/paketstatus\.aspx\?Lang=DE&amp;parcel=([^"&]{0,64})"/;
const COUNT = /<span id="lblMeldung">\s*(\d{1,4}) Ergebnisse\s*<\/span>/;
const TABLE = /<table\b[^>]*\bid="tntGrid"[^>]*>([\s\S]*?)<\/table>/;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
const HEADER = 'sendungsnummer|datum|zeit|bemerkung|status';
const DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_ROWS = 500;
// DER KURIER reuses parcel numbers, and the tracker lists every parcel that carried one under it.
// Rows further apart than this belong to different parcels.
const PARCEL_GAP_MS = 60 * 86_400_000;
// The remarks the tracker words alike for every parcel. Any other remark is a driver's free text,
// which can name the recipient, and is never read.
const REMARKS = new Set(['empfänger nicht angetroffen', 'kunde nicht angetroffen', 'retoure']);
// The order service's answer for a number it holds no order under: "No order for parcel-no 2060111854".
const NO_ORDER = /^No order for parcel-no (\d{1,12})$/;

/** A DER KURIER parcel number: eleven digits, or the label's twelve without their check digit. */
export function normalizeDerKurierNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const match = NUMBER.exec(number);
  if (!match) throw new InvalidInputError(PROVIDER, 'DER KURIER parcel numbers are eleven digits');
  return match[1]!;
}

/**
 * The number in the layout DER KURIER's tracking widget marks as GLS's: with 8 and 5 third and
 * fourth, the 8 moves to the front. The widget asks for that form when the number itself finds
 * nothing, and the tracker can list a parcel under it.
 */
export function derKurierGlsForm(number: string): string {
  return number.length === 11 && number[2] === '8' && number[3] === '5' ? `${number[2]}${number.slice(0, 2)}${number.slice(3)}` : number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

interface Row { readonly parcel: string; readonly day: string; readonly time: string; readonly remark: string; readonly status: string }

/** The table's rows under their parcel number, which the tracker writes on a parcel's first row only. */
function rowsOf(html: string): Row[] {
  const count = COUNT.exec(html);
  if (!count) return invalid('DER KURIER returned a page without its result count');
  const table = TABLE.exec(html)?.[1];
  if (table === undefined) return Number(count[1]) === 0 ? [] : invalid('DER KURIER returned a result count without its table');
  const [header, ...cells] = [...table.matchAll(ROW)].map((row) => [...row[1]!.matchAll(CELL)].map((cell) => textFromHtml(cell[1], 300)));
  if (!header || header.join('|').toLowerCase() !== HEADER) return invalid('DER KURIER returned an unreadable table');
  if (cells.length > MAX_ROWS || cells.length !== Number(count[1])) return invalid('DER KURIER returned a table that disagrees with its count');
  let parcel = '';
  return cells.map((row) => {
    if (row.length !== 5) return invalid('DER KURIER returned an unreadable row');
    const [label, day, time, remark, status] = row as [string, string, string, string, string];
    parcel = label || parcel;
    if (!parcel) return invalid('DER KURIER returned rows without their parcel number');
    return { parcel, day, time, remark, status };
  });
}

/** A row's wall clock: the tracker gives the station's day and time, without a zone. */
function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = TIME.exec(time);
  const calendar = date ? calendarDay(Number(date[3]), Number(date[2]), Number(date[1])) : null;
  return calendar && clock ? `${calendar}T${clock[1]}:${clock[2]}:00` : invalid('DER KURIER returned an invalid scan time');
}

/** The status column, with the remark joined after a colon when it is one the tracker words alike for every parcel. */
function wording(row: Row): string {
  if (!row.status) return invalid('DER KURIER returned a row without its status');
  return REMARKS.has(row.remark.toLocaleLowerCase('de-DE')) ? `${row.status}: ${row.remark}` : row.status;
}

/** The newest parcel's rows, newest first: the rows up to the first gap wider than any one parcel's. */
function newestParcel(events: CarrierEvent[]): CarrierEvent[] {
  const sorted = [...events].sort((a, b) => (a.local_time! < b.local_time! ? 1 : a.local_time! > b.local_time! ? -1 : 0));
  const end = sorted.findIndex((event, index) => index > 0
    && Date.parse(`${sorted[index - 1]!.local_time}Z`) - Date.parse(`${event.local_time}Z`) > PARCEL_GAP_MS);
  return end < 0 ? sorted : sorted.slice(0, end);
}

/**
 * Reads the tracker's page for one number: the rows it lists under that number, or under its GLS
 * form when none are, on the station's wall clock. Null when the page lists neither: the tracker
 * then shows another parcel's rows, which says nothing about the number asked.
 */
export function parseDerKurier(html: string, number: string): CarrierResult | null {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DER KURIER returned a verification page');
  const echo = ECHO.exec(html);
  if (!echo) return invalid('DER KURIER returned a page without a lookup');
  if (echo[1] !== number) throw new IndeterminateError(PROVIDER, 'DER KURIER answered for another number');
  const rows = rowsOf(html);
  const gls = derKurierGlsForm(number);
  const own = rows.filter((row) => row.parcel === number);
  const listed = own.length ? own : gls === number ? [] : rows.filter((row) => row.parcel === gls);
  if (listed.length === 0) return null;

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of listed) {
    const local = wallClock(row.day, row.time);
    const description = wording(row);
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = derKurierStage(description);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  const history = newestParcel(events);
  const lead = leadingScan(history, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: history[0]!.description!,
    last_update: null,
    last_update_local: history[0]!.local_time!,
    expected_delivery: null,
    events: history,
  };
}

/**
 * The order service's answer for a number: `none` for its own answer that it holds no order
 * under it, `listed` for an order. Anything else is a changed reply.
 */
export function readDerKurierOrderFind(status: number, body: string, number: string): 'none' | 'listed' {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    throw new SchemaError(PROVIDER, 'DER KURIER’s order service returned a reply that is not JSON', { cause });
  }
  if (status >= 200 && status < 300) return 'listed';
  // The service reads the number as an integer, so its answer drops the leading zeroes.
  const asked = number.replace(/^0+(?=\d)/, '');
  if (status === 404 && isRecord(payload) && payload.status === 404 && typeof payload.detail === 'string'
    && NO_ORDER.exec(payload.detail)?.[1] === asked) return 'none';
  return invalid('DER KURIER’s order service returned an unexpected reply');
}
