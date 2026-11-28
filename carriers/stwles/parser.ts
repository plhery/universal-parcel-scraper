import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { statusMap, stwlesStage } from './status.js';

export const PROVIDER = 'Shengtai Logistics';
export const CARRIER = 'stwles';
// An order's page is five kilobytes, most of it the template.
export const STWLES_MAX_BYTES = 256 * 1024;
/** Every row is keyed in China by Shengtai's hubs and stations, on China's clock. */
export const STWLES_ZONE = 'Asia/Shanghai';

// Letters and digits with a digit: ten digits on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The history table, after the form, and its rows and cells.
const TABLE = /<table\b[^>]*\bclass="right_set2"[^>]*>([\s\S]*?)<\/table>/gu;
const ROW = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gu;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/gu;
const ORDER = /订单号[:：]\s*(.{1,60})$/u;
// The page's message line under the form: 无此订单！ for a number it holds no order under.
const MESSAGE = /<td\b[^>]*>\s*<font color\s*=\s*"red">([^<]{0,200})<\/font>\s*<\/td>/u;
const NOT_FOUND = /^无此订单[!！]?$/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The person, or station, a row names after the station: the courier who took the parcel out or the auditor.
const HANDLER = /的(?:小件员)?\[[^[\]]{0,40}\]/gu;
// A clause that gives a phone, the supplier or a remark: the parser keeps neither.
const DROPPED = /电话|手机|联系|供货商|备注|(?<![A-Z\d])\d{7,}/iu;
// A clause whose only value is empty, as the page writes a field nobody filled.
const EMPTY = /^[^[\]]*\[\s*\][；;，,]?$/u;
const PLACE = /\[([^[\]]{1,60})\]/u;
const MAX_ROWS = 300;

/** A Shengtai order number, without spaces or hyphens. */
export function normalizeStwlesNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Shengtai Logistics order numbers are 6 to 30 letters and digits');
  return number;
}

/**
 * A row's text with its bracketed values and without what names a person or gives a phone: the
 * courier or auditor after the station, then each clause that gives a phone, the supplier or a
 * remark, or leaves its field empty.
 */
export function stwlesText(value: string): string {
  const text = textFromHtml(value.replace(/<\/?font\b[^>]*>/giu, ''), 2000).replace(HANDLER, '');
  // A comma inside a bracketed value ends no clause.
  const kept = text.split(/(?<=[；;，,])(?![^[\]]*\])/u).map((clause) => clause.trim())
    .filter((clause) => clause && !DROPPED.test(clause) && !EMPTY.test(clause));
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's wall clock to the second; a time the calendar has not is a changed page. */
function wallClock(value: string): string {
  const match = CLOCK.exec(textFromHtml(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  return local;
}

/**
 * One order's page from `POST /stwl/order/orderFlowQueryByCwb`: a table whose first row names the
 * order (订单号, which must be the number asked), whose second heads the columns 操作时间, 操作人
 * and 操作过程, and whose other rows are the history, oldest first. The operator column names the
 * hub, the station or an administrator and is not read. Without the table, the message 无此订单！
 * under the form is the page's answer for a number it holds no order under.
 */
export function parseStwles(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeStwlesNumber(raw);
  const tables = [...body.matchAll(TABLE)];
  if (tables.length === 0) {
    const message = textFromHtml(MESSAGE.exec(body)?.[1] ?? '', 200);
    if (NOT_FOUND.test(message)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    if (message) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without a history`);
  }
  if (tables.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page with more than one history`);
  const rows = [...tables[0]![1]!.matchAll(ROW)].map((row) => [...row[1]!.matchAll(CELL)].map((cell) => cell[1]!));
  const order = ORDER.exec(textFromHtml(rows[0]?.[0] ?? '', 100))?.[1] ?? '';
  if (normalizeTrackingNumber(order) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  const heading = (rows[1] ?? []).map((cell) => textFromHtml(cell, 20));
  if (heading.join('|') !== '操作时间|操作人|操作过程') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const history = rows.slice(2);
  if (history.length > MAX_ROWS || history.some((cells) => cells.length !== 3)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);

  const seen = new Set<string>();
  const read: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, [clock, , text]] of history.entries()) {
    const local = wallClock(clock!);
    const description = stwlesText(text!);
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    // The import row's 分拨中心 alone names no hub.
    const place = PLACE.exec(description)?.[1];
    const location = place && place !== '分拨中心' ? clean(place, 80) : '';
    const time = isoTime(local, STWLES_ZONE);
    const staged = stwlesStage(description);
    read.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: STWLES_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  // Newest first; rows at one clock keep the page's order, which lists the newer last.
  const events = read.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index))
    .map((row) => row.event);
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the order without a row`, { reason: 'listed' });
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
