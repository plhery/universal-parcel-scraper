import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { copeStage, statusMap } from './status.js';

export const PROVIDER = 'cope-sensitive-freight';
/** The WordPress endpoint the tracking pop-up on www.cope.com.au posts the number to. */
export const COPE_LOOKUP = 'https://www.cope.com.au/wp-admin/admin-ajax.php';
/** The theme's action, which fetches the consignment's page from COPE's eSmart system. */
export const COPE_ACTION = 'get_consignment';
// The empty page is 2 kB and a row adds about 200 bytes.
export const COPE_MAX_BYTES = 512 * 1024;

// The sending customer's letter code, then its counter, as eSmart's consignment notes print them.
const NUMBER = /^[A-Z]{1,6}\d{4,12}$/;
// A firewall's or bot check's page in place of eSmart's.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// "12/05/2026 16:11": an Australian wall clock, day first, without a zone.
const CLOCK = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):([0-5]\d)$/;
const DAY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
// An activity that names who took the parcel, or gives a phone number, is left out.
const PERSONAL = /\b(?:received|signed|collected|taken)\s+by\b|\b(?:receiver|recipient|consignee|signatory|phone|mobile|contact)\b[^:]{0,12}:|(?:\d[\s()-]?){8,}/i;
const HEAD = ['Tracking Number', 'Date Added', 'Service Type', 'Estimated Delivery Days', 'Estimated Delivery Date', 'Current Stage'];
const COLUMNS = ['Time', 'Location', 'Activity', 'Stage'];
const MAX_ROWS = 200;

/** A consignment number for COPE's tracker, which matches it whole and in capitals only. */
export function normalizeCopeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'COPE consignment numbers are the sender\'s letter code, then digits');
  return number;
}

/** Whether a reply is a block page instead of eSmart's. */
export function isCopeBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(value: string): string {
  const match = CLOCK.exec(value);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!match || !day || Number(match[4]) > 23) return invalid('COPE returned a tracking row without its clock');
  return `${day}T${match[4]!.padStart(2, '0')}:${match[5]}:00`;
}

/** The two tables eSmart's page holds, both `#tableContent`: the consignment's head, then its rows. */
function tablesOf($: CheerioAPI) {
  const tables = $('table#tableContent').toArray();
  if (tables.length !== 2) return invalid('COPE changed its tracking page');
  const head = new Map($(tables[0]).find('tr').toArray().map((row) => {
    const cells = $(row).children('td').toArray().map((cell) => clean($(cell).text(), 120));
    return [cells[0] ?? '', cells[1] ?? ''] as const;
  }));
  if (HEAD.some((field) => !head.has(field))) return invalid('COPE changed its consignment head');
  const rows = $(tables[1]).find('tr').toArray().map((row) => $(row).children('td').toArray().map((cell) => clean($(cell).text(), 200)));
  if (rows[0]?.join('|') !== COLUMNS.join('|')) return invalid('COPE changed its tracking table');
  return { head, rows: rows.slice(1) };
}

function eventOf(cells: string[]): CarrierEvent & { local_time: string; description: string } {
  if (cells.length !== COLUMNS.length) return invalid('COPE returned an invalid tracking row');
  const [time, location, activity, code] = cells as [string, string, string, string];
  if (!activity || !code) return invalid('COPE returned a tracking row without its activity');
  const staged = copeStage(code, activity);
  return {
    local_time: wallClock(time),
    description: PERSONAL.test(activity) ? code : activity,
    provider_code: code,
    ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The estimate the head gives, while the consignment is still on its way and the day is not behind its newest row. */
function estimateOf(value: string, stage: Stage | undefined, newest: string): string | null {
  const match = DAY.exec(value);
  const day = match ? calendarDay(Number(match[3]), Number(match[2]), Number(match[1])) : null;
  if (!day || stage === 'delivered' || stage === 'returned' || day < newest.slice(0, 10)) return null;
  return day;
}

/**
 * eSmart's tracking page for one number, as the WordPress action relays it: a head with the
 * consignment number, the day it was added, its service, the estimate and the current stage, then
 * a row per event, oldest first, with its time, the suburb and state, the activity and the stage.
 * A number eSmart does not hold gets the same page with every field empty and no row, which the
 * site's script shows as "No data found for this tracking number".
 */
export function parseCope(html: string, rawNumber: string): CarrierResult {
  const number = normalizeCopeNumber(rawNumber);
  if (isCopeBlocked(html)) throw new ChallengeError(PROVIDER, 'COPE answered with a browser check');
  const { head, rows } = tablesOf(load(html));
  const named = head.get('Tracking Number')!;
  if (!named) {
    if (rows.length === 0 && HEAD.every((field) => !head.get(field))) throw new NotFoundError(PROVIDER, 'COPE has no consignment under this number');
    return invalid('COPE returned tracking rows without their consignment');
  }
  if (normalizeTrackingNumber(named) !== number) throw new IndeterminateError(PROVIDER, 'COPE answered for another consignment');
  if (rows.length > MAX_ROWS) return invalid('COPE returned too many tracking rows');
  // Rows come oldest first; reversed, two of one minute keep the carrier's order.
  const events = rows.map(eventOf).reverse();
  if (!events.length) throw new NoHistoryError(PROVIDER, 'COPE lists the consignment without a tracking row', { reason: 'listed' });
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  const service = head.get('Service Type');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    provider_code: latest.provider_code!,
    last_status_text: latest.description,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: estimateOf(head.get('Estimated Delivery Date')!, stage, latest.local_time),
    ...(service ? { service_name: service } : {}),
    events,
  };
}
