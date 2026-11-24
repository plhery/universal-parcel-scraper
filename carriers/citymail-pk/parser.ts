import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { cityMailStage, statusMap } from './status.js';

export const PROVIDER = 'citymail-pk';
export const CITYMAIL_ORIGIN = 'https://my.citymail.com.pk';
/** The tracking page, which gives the session its cookies and its token. */
export const CITYMAIL_PAGE = `${CITYMAIL_ORIGIN}/track`;
/** Where the page's script posts the number, as `cn_no`. */
export const CITYMAIL_LOOKUP = `${CITYMAIL_ORIGIN}/get-tracking-data-web`;
// The page is 3 kB and a reply with two rows about as much; a row adds about 150 bytes.
export const CITYMAIL_MAX_BYTES = 256 * 1024;

// The page's script looks a number up once nine characters are typed.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{9}$/;
const NOT_FOUND = 'Invalid consignment no';
// Laravel's token for the session, in the page's head.
const TOKEN = /<meta\s+name=["']csrf-token["']\s+content=["']([A-Za-z0-9]{20,100})["']/i;
// A firewall's or bot check's page in place of the tracker's.
const BLOCKED = /<title>\s*(?:Request Rejected|Access Denied|Just a moment|Attention Required)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
// "28 Aug 2025, 06:28 PM - Booked - Shipment is booked": a wall clock, the status, then its remark.
const ROW = /^(\d{1,2}) ([A-Za-z]{3}) (\d{4}), (\d{1,2}):([0-5]\d) ([AP]M) - (.+)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// A remark that names who took the parcel, or gives a phone number, is left out.
const PERSONAL = /\b(?:received|signed|collected|taken)\s+by\b|\b(?:receiver|recipient|consignee|cnic|phone|mobile|cell|contact)\b[^:]{0,12}:|(?:\d[\s()-]?){9,}/i;
const MAX_ROWS = 200;

/** A number for CityMail's tracker: the nine-character consignment number. */
export function normalizeCityMailNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the nine-character CityMail consignment number');
  return number;
}

/** Whether a page is a block page instead of the tracker's. */
export function isCityMailBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** The session token the tracking page gives its script. */
export function cityMailToken(page: string): string {
  return TOKEN.exec(page)?.[1] ?? invalid('CityMail changed its tracking page');
}

function rowOf(text: string): CarrierEvent & { local_time: string; description: string } {
  const match = ROW.exec(text);
  const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) + 1 : 0;
  const day = match ? calendarDay(Number(match[3]), month, Number(match[1])) : null;
  const hour = match ? Number(match[4]) : 0;
  if (!match || !day || hour < 1 || hour > 12) return invalid('CityMail returned an invalid tracking row');
  const hour24 = (hour % 12) + (match[6]!.toUpperCase() === 'PM' ? 12 : 0);
  const rest = match[7]!;
  const split = rest.indexOf(' - ');
  const status = clean(split < 0 ? rest : rest.slice(0, split), 80);
  const remark = split < 0 ? '' : clean(rest.slice(split + 3), 200);
  if (!status) return invalid('CityMail returned a tracking row without its status');
  const staged = cityMailStage(status);
  return {
    local_time: `${day}T${String(hour24).padStart(2, '0')}:${match[5]}:00`,
    description: remark && !PERSONAL.test(remark) ? `${status} - ${remark}` : status,
    provider_code: status,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * The parcel the reply's HTML shows: a head with the consignment number, the booking date, the
 * customer who booked it, the customer's reference and the cities it goes from and to, then its
 * tracking rows, oldest first. The adapter keeps the rows, newest first, on their wall clock.
 */
function parcelOf(html: string, number: string): CarrierResult {
  const $ = load(html);
  const fields = new Map($('.infodiv').toArray()
    .map((item) => [clean($(item).find('.boldspan').text(), 40).toUpperCase(), clean($(item).find('.boldbl').text(), 80)]));
  const named = fields.get('CN#');
  if (!named) return invalid('CityMail returned a parcel without its consignment number');
  if (normalizeTrackingNumber(named) !== number) throw new IndeterminateError(PROVIDER, 'CityMail answered for another consignment');
  const cells = $('.track-details > div > span').toArray();
  if (cells.length > MAX_ROWS) return invalid('CityMail returned too many tracking rows');
  const events = cells.map((cell, index) => ({ index, event: rowOf(clean($(cell).text(), 400)) }))
    // Rows come oldest first; of two at one minute, the later row is the newer.
    .sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index)
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'CityMail lists the consignment without a tracking row', { reason: 'listed' });
  const latest = events[0]!;
  const current = leadingScan(events, statusMap);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    provider_code: latest.provider_code!,
    last_status_text: latest.description,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    events,
  };
}

/**
 * The tracker's JSON for one number: status 1 with the parcel as an HTML fragment, or status 0
 * with "Invalid consignment no" for a number it does not know. The reply answers the one request
 * that posted the number; the fragment names it too, and must name the number asked.
 */
export function parseCityMail(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeCityMailNumber(rawNumber);
  if (!isRecord(payload)) return invalid('CityMail returned an unreadable reply');
  if (payload.status === 1 && typeof payload.payload === 'string') return parcelOf(payload.payload, number);
  if (payload.status === 0 && payload.message === NOT_FOUND) throw new NotFoundError(PROVIDER);
  return invalid('CityMail returned an unexpected reply');
}
