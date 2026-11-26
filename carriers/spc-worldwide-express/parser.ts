import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { spcCodeStage } from './status.js';

export const PROVIDER = 'spc-worldwide-express';
// A result page is about 8 kB.
export const SPC_MAX_BYTES = 256 * 1024;

// The tracker takes consignment numbers in letters and digits; the ones published are digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
// "2023-Mar-13 10:00": the station's wall clock, with no zone.
const CLOCK = /^(\d{4})-([A-Z][a-z]{2})-(\d{1,2}) ([01]?\d|2[0-3]):([0-5]\d)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "DELIVERED", "OUT4DELIV", "SHP_RETURN".
const CODE = /^[A-Z][A-Z0-9_]{1,19}$/;
// A station: "SPC-KCH", or an airport code alone such as "SBW".
const STATION = /^[A-Z0-9][A-Z0-9 -]{0,29}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const RESULT = '#ctl00_ContentPlaceHolder1_track_result';
const NOT_FOUND = 'No Record Found!';
const COLUMNS = ['', 'Date', 'Location', 'Status'];
const MAX_ROWS = 200;

/** A consignment number for SPC's tracker. */
export function normalizeSpcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the consignment number on the SPC Worldwide Express note');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(text: string): string {
  const parts = CLOCK.exec(text);
  const month = parts ? MONTHS.indexOf(parts[2]!) + 1 : 0;
  const date = parts && month ? calendarDay(Number(parts[1]), month, Number(parts[3])) : null;
  if (!parts || !date || Number(parts[1]) < 2000) return invalid('SPC returned an invalid scan time');
  return `${date}T${parts[4]!.padStart(2, '0')}:${parts[5]}:00`;
}

type Row = { order: number; event: CarrierEvent & { local_time: string; provider_code: string } };

/** The result table's rows, which the tracker numbers from the oldest. */
function rowsOf($: CheerioAPI, table: ReturnType<CheerioAPI>): Row[] {
  const rows = table.find('tr').toArray();
  const header = $(rows.shift()).children('th').toArray().map((cell) => clean($(cell).text(), 40));
  if (header.join('|') !== COLUMNS.join('|')) return invalid('SPC changed its result columns');
  if (rows.length > MAX_ROWS) return invalid('SPC returned too many rows');
  return rows.map((row) => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 60));
    const [order, clock, station, code] = cells;
    if (cells.length !== COLUMNS.length || !/^\d{1,3}$/.test(order ?? '') || !code || !CODE.test(code)) {
      return invalid('SPC returned an invalid row');
    }
    if (station && !STATION.test(station)) return invalid('SPC returned an invalid station');
    const stage = spcCodeStage(code);
    return { order: Number(order), event: {
      local_time: wallClock(clock ?? ''), description: code, provider_code: code,
      ...(station ? { location: station } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } };
  });
}

/**
 * The tracker's result page for one number, `tracking2.aspx?ref=`, which its
 * server renders: the number asked as "CN: …", then a table of numbered rows
 * (date, station, status code), or "No Record Found!" for a number it does
 * not know. The page must name the number asked.
 */
export function parseSpc(html: string, raw: string): CarrierResult {
  const number = normalizeSpcNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'SPC answered with a browser check');
  const $ = load(html);
  const result = $(RESULT);
  if (result.length !== 1) return invalid('SPC returned a page without its tracking result');
  const labels = result.find('b').filter((_, label) => /^CN:/.test(clean($(label).text(), 80)));
  if (labels.length !== 1) return invalid('SPC returned an unexpected tracking result');
  if (normalizeTrackingNumber(clean(labels.text(), 80).slice(3)) !== number) {
    throw new IndeterminateError(PROVIDER, 'SPC answered for another consignment');
  }
  const tables = result.find('table');
  const missing = result.find('font').toArray().some((notice) => clean($(notice).text(), 40) === NOT_FOUND);
  if (!tables.length && missing) throw new NotFoundError(PROVIDER, 'SPC has no record of this consignment');
  if (tables.length !== 1 || missing) return invalid('SPC returned an unexpected tracking result');

  // Newest first; rows of one minute keep the tracker's numbering.
  const events = rowsOf($, tables)
    .sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.order - a.order)
    .map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code,
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}
