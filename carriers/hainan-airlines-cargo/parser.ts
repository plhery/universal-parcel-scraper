import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { hainanCargoStage } from './status.js';

export const PROVIDER = 'Hainan Airlines Cargo';
// A page with a long history is a few tens of kilobytes.
export const HAINAN_CARGO_MAX_BYTES = 512 * 1024;
/** The message the page shows for a verify code it refuses. */
export const HAINAN_CARGO_REFUSED = 'Hainan Airlines Cargo refused the verify code';

// The airline prefix, an airport's three letters some forwarders write after it, then the serial.
const NUMBER = /^880(?:[A-Z]{3})?(\d{8})$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))?$/;
// A station cell: the airport's IATA code, then its name in brackets.
const STATION = /^([A-Z]{3})(?:\s*[（(][^)）]*[)）])?$/;
const MAX_ROWS = 300;
const MAX_EVENTS = 100;

/**
 * A Hainan Airlines air waybill: the prefix 880 and an eight-digit serial whose last digit is the
 * remainder of the first seven divided by seven, the IATA check. Some forwarders write the origin
 * airport between them ("880-PEK-…"); the tracker takes the prefix and the serial.
 */
export function normalizeHainanCargoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const serial = NUMBER.exec(number)?.[1];
  if (!serial || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(PROVIDER, 'Hainan Airlines Cargo air waybills are 880 and eight digits ending in the air waybill check digit');
  }
  return `880${serial}`;
}

/** The air waybill as the tracking form takes it: the prefix, a dash and the serial. */
export function hainanCargoFormNumber(number: string): string {
  return `${number.slice(0, 3)}-${number.slice(3)}`;
}

function text(html: string): string {
  return textFromHtml(html, 400);
}

/** One element's inner HTML by its id, or null when the page has none. */
function byId(html: string, id: string, tag: string): string | null {
  const match = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return match ? match[1]! : null;
}

function rows(table: string): string[][] {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>)/gi)].slice(0, MAX_ROWS + 1)
    .map((row) => [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => text(cell[1]!)));
}

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  if (!match) throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned an invalid scan time');
  const local = `${match[1]}T${match[2]}:${match[3] ?? '00'}`;
  // Parsing in UTC checks the calendar alone; the wall clock keeps no offset.
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned an invalid scan time');
  }
  return local;
}

/**
 * The page `/Portal2/AwbSearch.aspx` returns for one air waybill. A found air waybill has a tab
 * named after it, a table of its route, goods and weights, then a table of its scans: station,
 * local time, operation, flight, pieces and weight. An unknown one leaves the tab empty and shows
 * only the contact line. A refused verify code shows an error notice instead.
 */
export function parseHainanCargo(html: string, raw: string): CarrierResult {
  const number = normalizeHainanCargoNumber(raw);
  if (/pageNoty\(\s*["']error["']\s*,\s*["']验证码/.test(html)) throw new ChallengeError(PROVIDER, HAINAN_CARGO_REFUSED);
  const tab = byId(html, 'MainContent_divTab', 'ul');
  const content = byId(html, 'MainContent_divContent', 'div');
  if (tab === null || content === null) throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned a page without its tracking result');
  const asked = text(tab);
  if (!asked) {
    // The page answers an air waybill it does not know with its contact line alone.
    if (/Contact\.aspx/i.test(content) && !/<table\b/i.test(content)) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned a result without its air waybill');
  }
  // One tab per air waybill asked; the form asks one.
  const named = [...tab.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => normalizeTrackingNumber(text(item[1]!)));
  if (named.length !== 1 || named[0] !== number) throw new IndeterminateError(PROVIDER, 'Hainan Airlines Cargo answered for another air waybill');

  const table = /<table\b[^>]*class=["'][^"']*\bstatus-list\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(content);
  if (!table) throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned a result without its scans');
  const [head, ...body] = rows(`${table[1]}</table>`);
  if (!head || head[0] !== '站点' || head[2] !== '操作') throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo changed its scan table');
  if (body.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned an oversized history');

  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const cells of body) {
    if (!cells.length) continue;
    const [stationCell = '', clock = '', wording = ''] = cells;
    if (!wording) throw new SchemaError(PROVIDER, 'Hainan Airlines Cargo returned a scan without its operation');
    const local = wallClock(clock);
    const station = STATION.exec(stationCell)?.[1] ?? stationCell;
    const key = JSON.stringify([local, station, wording]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = hainanCargoStage(wording);
    events.push({
      local_time: local,
      ...(station ? { location: station } : {}),
      description: wording,
      provider_code: wording,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first by wall clock; the page lists them oldest first.
  events.reverse().sort((left, right) => (left.local_time! < right.local_time! ? 1 : left.local_time! > right.local_time! ? -1 : 0));

  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
