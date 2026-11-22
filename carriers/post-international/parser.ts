import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { postInternationalStage } from './status.js';

export const PROVIDER = 'Post-International';
/** The home page, whose tracking form takes the WordPress nonce its lookups send from the page. */
export const POST_INT_HOME = 'https://post-int.com/';
/** The WordPress handler the home page's tracking form posts to. */
export const POST_INT_AJAX = 'https://post-int.com/wp-admin/admin-ajax.php';
export const POST_INT_ACTION = 'post_int_home_tracking_action';
export const POST_INT_MAX_BYTES = 1024 * 1024;
export const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)|lsrecaptcha|sgcaptcha|imunify360/i;
// The tracking form's settings in the page, up to their nonce.
const PAGE_NONCE = /var myajax\s*=\s*\{[^<]{0,500}?"nonce"\s*:\s*"([0-9a-f]{6,32})"/;
const HEADING = /<h2>\s*Відправлення№\s*([^<]{0,64}?)\s*<\/h2>/g;
const TTN = /<span id="post-int-ttn-num">([^<]{0,60})<\/span>/;
const ROW = /<tr>([\s\S]*?)<\/tr>/g;
const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
// Rows the system dates by their day alone carry midnight and a count of seconds: 00:00:01, 00:00:02.
const DAY_ONLY = /^00:00:0\d$/;
// The onward carriers the current status names in its delivery service column, by catalog id.
const DELIVERY_SERVICES: ReadonlyMap<string, string> = new Map([
  ['новая почта', 'nova-poshta'], ['нова пошта', 'nova-poshta'], ['укрпошта', 'ukrposhta'], ['укрпочта', 'ukrposhta'],
]);

/** Post-International's tracker takes its own numbers and its partners' references: letters and digits. */
export function normalizePostIntNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{8,32}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'Post-International numbers are letters and digits');
  return number;
}

/** The nonce the home page gives its tracking form, or undefined when the page has none. */
export function postIntPageNonce(html: string): string | undefined {
  return PAGE_NONCE.exec(html)?.[1];
}

/** The cells of each data row in the table after a heading. */
function tableAfter(html: string, heading: string): string[][] {
  const start = html.indexOf(heading);
  const tableStart = start < 0 ? -1 : html.indexOf('<table', start);
  const tableEnd = tableStart < 0 ? -1 : html.indexOf('</table>', tableStart);
  if (tableEnd < 0) throw new SchemaError(PROVIDER, 'Post-International returned a shipment without its tables');
  const table = html.slice(tableStart, tableEnd);
  const rows = [...table.matchAll(ROW)].map(([, row]) => [...row!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map(cell => textFromHtml(cell[1], 300)));
  // The header row has no cells; every other row has the table's three.
  if (rows.length > 300 || rows.length !== (table.match(/<tr\b/g)?.length ?? 0) || rows.filter(cells => cells.length).length !== rows.length - 1
    || rows.slice(1).some(cells => cells.length !== 3)) {
    throw new SchemaError(PROVIDER, 'Post-International returned an invalid table row');
  }
  return rows.slice(1);
}

/** A row's date and time, which the page gives on Kyiv's wall clock with no zone. */
function clockOf(date: string, time: string): string {
  const day = DATE.exec(date);
  const iso = day ? calendarDay(+day[3]!, +day[2]!, +day[1]!) : null;
  if (!iso || !CLOCK.test(time)) throw new SchemaError(PROVIDER, 'Post-International returned an invalid status time');
  return DAY_ONLY.test(time) ? iso : `${iso}T${time}`;
}

/**
 * The tracker's reply for one number: JSON whose `orderStatus` is the HTML of the shipment's
 * heading, current status, onward waybill (ТТН) and status history, oldest first, or empty for a
 * number the tracker does not know. The tracker also matches other numbers on file, so a reply is
 * the shipment asked only when its heading repeats the whole number.
 */
export function parsePostInt(body: string, raw: string): CarrierResult {
  const number = normalizePostIntNumber(raw);
  // The handler writes blank lines before its JSON.
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) throw new SchemaError(PROVIDER, 'Post-International returned an empty reply');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Post-International answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'Post-International returned a reply that is not JSON', { cause });
  }
  const data = isRecord(payload) && payload.success === true && isRecord(payload.data) ? payload.data : undefined;
  if (!data) throw new SchemaError(PROVIDER, 'Post-International returned an unexpected reply');
  // The form shows an error under itself; none has been seen, so it says nothing about the number.
  if (typeof data.error === 'string' && data.error.trim()) throw new IndeterminateError(PROVIDER, 'Post-International answered with an error');
  if (typeof data.orderStatus !== 'string') throw new SchemaError(PROVIDER, 'Post-International returned a reply without its status');
  const html = data.orderStatus;
  if (!html.trim()) throw new NotFoundError(PROVIDER);
  const headings = [...html.matchAll(HEADING)].map(match => match[1]!.replace(/\s+/g, '').toUpperCase());
  if (headings.length !== 1) throw new SchemaError(PROVIDER, 'Post-International returned a status without its heading');
  if (headings[0] !== number) throw new IndeterminateError(PROVIDER, 'Post-International answered with another shipment');
  const current = tableAfter(html, '<h3>Поточний статус</h3>');
  if (current.length !== 1) throw new SchemaError(PROVIDER, 'Post-International returned an invalid current status');
  const courier = DELIVERY_SERVICES.get(normalizeStatusWording(current[0]![1]!));
  const ttn = (TTN.exec(html)?.[1] ?? '').replace(/\s+/g, '').toUpperCase();
  const reference = /^[A-Z0-9]{4,40}$/.test(ttn) && ttn !== number ? ttn : undefined;
  // A courier without its waybill is no hand-off.
  const carrier = reference ? courier : undefined;
  const events: CarrierEvent[] = [];
  for (const [description, date, time] of tableAfter(html, '<h3>Історія статусів відправлення</h3>')) {
    if (!description) continue;
    const stage = postInternationalStage(description);
    events.push({ local_time: clockOf(date!, time!), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'Post-International lists the shipment without a status history',
      { reason: 'listed', deliveryCarrier: carrier, deliveryTrackingNumber: reference });
  }
  const newest = events.at(-1)!;
  const stage = newest.stage as ReturnType<typeof postInternationalStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    ...(carrier ? { delivery_carrier: carrier } : {}), ...(reference ? { delivery_tracking_number: reference } : {}), events: events.slice(-200) };
}
