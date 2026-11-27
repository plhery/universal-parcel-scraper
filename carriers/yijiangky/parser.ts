import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { statusMap, yijiangStage } from './status.js';

export const PROVIDER = 'Yijiang Express';
export const CARRIER = 'yijiangky';
// A reply is under two kilobytes for a dozen rows.
export const YIJIANG_MAX_BYTES = 256 * 1024;
/** The firm's clock: it is in Fuzhou and its rows are its depots' in China. */
export const YIJIANG_ZONE = 'Asia/Shanghai';

// Letters and digits with a digit: YJ and twelve digits on the public sample. The form splits numbers at ",".
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "2026-05-11 10:02:36": a wall clock to the second, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/;
// The lookup's answer for numbers the firm holds nothing under.
const NOT_FOUND = '查无结果';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|yunsuo_session|safedog|网站防火墙|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝|访问拦截)/i;
const MAX_ROWS = 200;

// The people a row may name by their role: the collector, a courier, the driver or the signer.
const ROLE = '(?:收件员|揽收员|揽件员|取件员|派件员|派送员|快递员|业务员|配送员|司机|签收人)';
// "签收人：张三": the role, its label and the name all go.
const LABELLED = new RegExp(`[，,]?\\s*${ROLE}\\s*[:：]\\s*[^\\s，,。；;！!（）()【】\\[\\]:：\\d]{1,12}`, 'gu');
// "派件员【张三】": the name in brackets goes, the role stays.
const BRACKETED = new RegExp(`(${ROLE})\\s*(?:【[^】]{1,12}】|\\[[^\\]]{1,12}\\])`, 'gu');
// "派送员张三，" or "派送员张三正在派件": a name of two to four characters right after the role, before a pause, a
// phone or the verb, goes. "派送员正在派件" and "交给派送员," name no one and stay.
const BARE = new RegExp(`(${ROLE})(?![正在已将准派送配揽收签的您进处前])\\p{Script=Han}{2,4}?(?=[\\s，,。；;！!（(]|电话|手机|联系|正在|已|将|为您|派件|派送|\\d|$)`, 'gu');
// A phone number, with its label: seven or more digits, as phones are written, read from its first digit. A
// waybill after 单号 stays, and so does the firm's own 400 or 800 service line.
const PHONE = /(?:[，,]?\s*(?:联系)?(?:电话|手机)\s*[:：]?\s*)?(?<![A-Z\d])(?<!\d[\s-])(?<!单号\s*[:：]?\s*)(?![48]00[\s-]?\d{3}[\s-]?\d{4}(?![\s-]?\d))\+?\d(?:[\s-]?\d){6,}(?![A-Z\d])/giu;

/** A Yijiang waybill, without spaces or hyphens. */
export function normalizeYijiangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Yijiang Express waybills are 6 to 30 letters and digits');
  return number;
}

/** A row's wording without the people it names or a phone number. */
export function yijiangText(value: string): string {
  return clean(value.replace(LABELLED, '').replace(BRACKETED, '$1').replace(BARE, '$1').replace(PHONE, ''), 300)
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/\s+(?=[，,。；;！!])/g, '')
    .replace(/([，,。；;！!])[，,。；;！!]+/g, '$1')
    .replace(/^[\s，,。；;:：]+|[\s，,；;:：]+$/g, '');
}

/** A row's wall clock, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = CLOCK.exec(clean(value, 40));
  const day = match ? calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
  if (!match || !day || Number(match[1]) < 2001 || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  return `${day}T${match[4]}:${match[5]}:${match[6] ?? '00'}`;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

interface Row {
  readonly local: string;
  readonly description: string;
  readonly location: string;
}

/**
 * The rows of the waybill whose number is the whole number asked, newest first as the reply lists them. The
 * reply is `{result, message, data}`: "SUCCESS" with an entry for each number found, its `num` and `details`, or
 * "查无结果" with `data` "[]" when the firm holds nothing under the number. Any other reply is a changed lookup.
 */
export function yijiangRows(body: string, raw: string): Row[] {
  const number = normalizeYijiangNumber(raw);
  let reply: Record<string, unknown> | null;
  try {
    reply = record(JSON.parse(body));
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not JSON`);
  }
  if (!reply || reply.result !== 'true') throw new SchemaError(PROVIDER, `${PROVIDER} refused the lookup`);
  if (reply.message === NOT_FOUND) {
    if (reply.data !== '[]' && !(Array.isArray(reply.data) && reply.data.length === 0)) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned its not-found answer with data`);
    }
    throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  }
  if (reply.message !== 'SUCCESS' || !Array.isArray(reply.data)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an unknown answer`);
  const entries = reply.data.map(record);
  if (entries.some((entry) => !entry)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid waybill`);
  const bound = entries.filter((entry) => normalizeTrackingNumber(clean(entry!.num, 64)) === number);
  if (bound.length === 0) throw new IndeterminateError(PROVIDER, `${PROVIDER} answered for another number`);
  if (bound.length > 1) throw new SchemaError(PROVIDER, `${PROVIDER} listed the waybill twice`);
  const details = bound[0]!.details;
  if (!Array.isArray(details) || details.length === 0) throw new SchemaError(PROVIDER, `${PROVIDER} returned a waybill without rows`);
  if (details.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return details.map((detail) => {
    const row = record(detail);
    if (!row || typeof row.context !== 'string' || (row.location !== undefined && typeof row.location !== 'string')) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    }
    return { local: wallClock(row.time), description: yijiangText(row.context), location: clean(row.location, 60) };
  });
}

/**
 * The firm's history for one waybill, newest first. Each row's clock is a wall clock without a zone; the firm is
 * in Fuzhou and its rows are its depots' in China, so each keeps its wall clock and is dated on China's clock. A
 * clock that would date a row after the lookup leaves it its wall clock alone. The people a row names and phone
 * numbers come out of its wording, and a row left with nothing is dropped. The city each row gives is its location.
 */
export function parseYijiang(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const rows = yijiangRows(body, raw);
  const seen = new Set<string>();
  const dated = rows.flatMap((row, index) => {
    const key = JSON.stringify([row.local, row.description, row.location]);
    if (!row.description || seen.has(key)) return [];
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(row.local, { zone: YIJIANG_ZONE }));
    const staged = yijiangStage(row.description);
    const event: CarrierEvent = {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: YIJIANG_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: row.local,
      description: row.description,
      ...(row.location ? { location: row.location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [{ index, event }];
  });
  if (!dated.length) throw new SchemaError(PROVIDER, `${PROVIDER} returned rows without a readable scan`);
  // Newest first in the reply already; rows of one second keep its order.
  const events = dated.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || left.index - right.index)
    .map((entry) => entry.event);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
