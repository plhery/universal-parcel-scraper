import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fourAStage, statusMap } from './status.js';

export const PROVIDER = '4a-express';
/** The page method 4A Express's tracker posts `{"AWBNo": <number>}` to. */
export const FOUR_A_LOOKUP = 'https://cms.4aexpress.com/Query/TrackAwbNoQuery.aspx/ShowAwbNoQuery';
// A delivered shipment's reply is about 7 kB.
export const FOUR_A_MAX_BYTES = 512 * 1024;

// The questions page gives twelve digits; the tracker takes any text, and several numbers split
// by commas, so one number is letters and digits only, with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,20}$/;
// A firewall's, CDN's or bot check's page in place of the tracker's JSON.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|challenge-platform|captcha/i;
// The waybill's header row: "Awb No." and the number.
const AWB = /<th[^>]*>\s*Awb No\.\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i;
// The history table: its LOCATION, SHIPMENT ACTIVITIES and DATE columns.
const HISTORY = /<th[^>]*>\s*LOCATION\s*<\/th>\s*<th[^>]*>\s*SHIPMENT(?:&nbsp;|\s)+ACTIVITIES\s*<\/th>\s*<th[^>]*>\s*DATE\s*<\/th>[\s\S]*?<\/thead>([\s\S]*?)<\/tbody>/i;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
// "05-JAN-2024 12:25:59": the station's wall clock, without a zone.
const WALL_CLOCK = /^(\d{2})-([A-Z]{3})-(\d{4}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_ROWS = 200;

/** A number for 4A Express's tracker: letters and digits with at least one digit, in capitals. */
export function normalizeFourANumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, '4A Express tracks air waybills of 6 to 20 letters and digits');
  return number;
}

/** Whether a reply is a block page instead of the tracker's JSON. */
export function isFourABlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(value: string): string {
  const parts = WALL_CLOCK.exec(value.toUpperCase());
  const month = parts ? MONTHS.indexOf(parts[2]!) + 1 : 0;
  const day = parts && month && calendarDay(Number(parts[3]), month, Number(parts[1]));
  if (!parts || !day || Number(parts[3]) < 2000) return invalid('4A Express returned an invalid event time');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/** One history row: the station, the activity and the station's wall clock. */
function row(cells: string[]): CarrierEvent {
  const [location, description, time] = cells as [string, string, string];
  if (!description) return invalid('4A Express returned an event without its activity');
  const staged = fourAStage(description);
  return {
    local_time: wallClock(time),
    description,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The tracker's reply as JSON, or the reason it is not one. */
export function fourAJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch (cause) {
    if (isFourABlocked(body)) throw new ChallengeError(PROVIDER, '4A Express answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, '4A Express returned a reply that is not JSON', { cause });
  }
}

/**
 * The reply of `POST TrackAwbNoQuery.aspx/ShowAwbNoQuery`, the page method 4A Express's tracker
 * calls: `{"d": {"TrackingGrid": <html>, ...}}`. A shipment's grid has the waybill number, its
 * booking date, origin and destination, and its history, newest first, each row with the station,
 * the activity and the station's wall clock. A number it holds nothing under gets an empty grid.
 *
 * The delivery summary's "Received By" name and the booking date are never read.
 */
export function parseFourA(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFourANumber(raw);
  const reply = isRecord(payload) ? payload.d : undefined;
  if (!isRecord(reply) || typeof reply.TrackingGrid !== 'string') return invalid('4A Express returned an unexpected reply');
  const grid = reply.TrackingGrid;
  if (!grid.trim()) {
    // The tracker answers an unknown number with an empty grid; it does not say no shipment exists.
    throw new IndeterminateError(PROVIDER, '4A Express lists no shipment under the number', { reason: 'portal_not_found' });
  }
  const echoed = AWB.exec(grid)?.[1];
  if (echoed === undefined) return invalid('4A Express returned a shipment without its number');
  // The grid must name the number asked.
  if (normalizeTrackingNumber(textFromHtml(echoed, 40)).toUpperCase() !== number) {
    throw new IndeterminateError(PROVIDER, '4A Express answered for another shipment');
  }
  const history = HISTORY.exec(grid)?.[1];
  if (history === undefined) return invalid('4A Express returned a shipment without its history table');
  const rows = [...history.matchAll(ROW)].map(([, cells]) => [...(cells ?? '').matchAll(CELL)].map(([, cell]) => textFromHtml(cell ?? '', 200)));
  if (rows.length > MAX_ROWS) return invalid('4A Express returned too many events');
  if (rows.some((cells) => cells.length !== 3)) return invalid('4A Express returned an invalid history row');
  const events = rows.map(row);
  const newest = events[0];
  if (!newest) return invalid('4A Express returned a shipment without history');
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
