import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, tmwRecordStage, tmwStepStage } from './status.js';

export const PROVIDER = 'tmw-express';
export const TMW_MAX_BYTES = 512 * 1024;

// The label prints the order number as a Code 128 set A barcode, which has no lower case; the
// tracker gives no layout, so a number is letters and digits with a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The service's answer for an order it does not have, and for a request without a number.
const NOT_FOUND = '该订单不存在';
const NO_NUMBER = '未传递订单号';
// "2026-03-02 15:05:00": a wall clock, as the staff's date picker and the courier's rows write it.
const CLOCK = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
// Steps 0 and 2 have no wording in the tracker's script, which hides them.
const HIDDEN_STEPS = new Set(['0', '2']);
const MAX_ROWS = 300;

// The people in a Chinese courier's row: a courier or signer named after their role, in brackets or
// after a colon, and phone numbers, whole or masked, with the label before them.
const ROLE = '(?:快递员|快递小哥|派件员|派送员|配送员|收派员|业务员|取件员|揽件员|揽收员|签收人|代收人|联系人)';
const PERSON = new RegExp(`${ROLE}(?:\\s*(?:是|为)?\\s*[:：]?\\s*[[【(（][^\\]】)）]{0,30}[\\]】)）]|\\s*(?:是|为|[:：])\\s*[^\\s,，。；;！!（(【[\\d]{1,12})`, 'g');
const PHONE = /(?:(?:联系|派件|快递员)?(?:电话|手机|方式)\s*[:：]?\s*)?(?<![A-Za-z0-9])(?:\+?86[\s-]?)?(?:1[3-9]\d[\s-]?(?:\d{4}|\*{4})[\s-]?\d{4}|0\d{2,3}[\s-]?\d{7,8})(?!\d)/g;
const PHONE_LABEL = /(?:联系|派件|快递员)?(?:电话|手机|联系方式)\s*[:：]?\s*(?=[\s,，。；;！!\uE000]|$)/g;
// Where a removal was, until the text around it is tidied.
const CUT = '\uE000';

/** A number TMW Express's tracker takes: letters and digits, with a digit. */
export function normalizeTmwNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TMW Express order numbers are 6 to 40 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const folded = (value: unknown): string => cleanScalar(value, 80).toUpperCase().replace(/[\s./_-]/g, '');

/** A wall clock, or with `dayAtMidnight` the day alone of one at midnight; anything else is a changed reply. */
function clockOf(value: unknown, dayAtMidnight: boolean): string {
  const parts = CLOCK.exec(clean(value, 40));
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2000 || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    return invalid('TMW Express returned an unreadable clock');
  }
  const [hour, minute, second] = [parts[4]!.padStart(2, '0'), parts[5]!, parts[6] ?? '00'];
  return dayAtMidnight && hour === '00' && minute === '00' && second === '00' ? day : `${day}T${hour}:${minute}:${second}`;
}

/** A list of the reply's data: absent is empty; anything else than a list of objects is a changed reply. */
function rowsOf(data: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const rows = data[key];
  if (rows === null || rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || !rows.every(isRecord)) return invalid(`TMW Express returned an invalid ${key}`);
  return rows;
}

/** A courier's row without the people and phone numbers in it. */
export function withoutContacts(wording: string): string {
  const cut = wording.replaceAll(CUT, '').replace(PHONE, CUT).replace(PERSON, CUT).replace(PHONE_LABEL, CUT);
  if (!cut.includes(CUT)) return clean(cut, 500);
  // A cut takes the spaces around it, and the comma before it when punctuation or the end follows.
  return clean(cut.replace(/\s*\uE000[\s\uE000]*/g, CUT).replace(/[,，；;:：]?\uE000(?=[,，。；;！!]|$)/g, '')
    .replace(/^\uE000[\s,，。；;:：]*/, '').replaceAll(CUT, ''), 500);
}

interface Scan { event: CarrierEvent; leg: number; order: number }

/** A step the staff entered: its number, the wording the reply gives it, and its clock. */
function stepScan(row: Record<string, unknown>, index: number): Scan | null {
  const code = cleanScalar(row.stepno, 8);
  if (!/^\d{1,4}$/.test(code)) return invalid('TMW Express returned a step without its number');
  if (HIDDEN_STEPS.has(code)) return null;
  const description = clean(row.steptype, 200);
  if (!description) return invalid('TMW Express returned a step without wording');
  // The staff pick a step's time in a date picker, which sets midnight when they pick a day alone.
  const local = clockOf(row.steptime, true);
  const stage = tmwStepStage(code);
  return { leg: 0, order: Number(code) * 1_000 + index,
    event: { local_time: local, description, provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
}

/** A row of the Chinese courier that delivers, newest first as the courier's feed gives them. */
function recordScan(row: Record<string, unknown>, index: number): Scan {
  const description = withoutContacts(clean(row.context, 500));
  if (!description) return invalid('TMW Express returned a courier row without wording');
  // The tracker shows `ftime`; the courier's feed gives the same clock as `time` too.
  const local = clockOf(clean(row.ftime, 40) || row.time, false);
  const staged = tmwRecordStage(description);
  return { leg: 1, order: -index, event: { local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } };
}

/** Newest first; on one clock the courier's rows come after the steps, and later steps after earlier ones. */
const newestFirst = (left: Scan, right: Scan): number => {
  const [a, b] = [left.event.local_time!, right.event.local_time!];
  return (a < b ? 1 : a > b ? -1 : 0) || right.leg - left.leg || right.order - left.order;
};

/**
 * The reply of `POST /qt/order/searchAirStep` for one order number, which the tracker on
 * tmw-express.com.au and the label's page make. An order it does not have is `code` `fail`
 * with `该订单不存在`; another failure says nothing about the order. A found order is `code`
 * `success` with the steps TMW Express's staff entered (`airStepList`) and the rows of the
 * Chinese courier that delivers it (`logisticsrecordList`). The reply does not repeat the number;
 * one that names an order names the one asked.
 */
export function parseTmw(payload: unknown, raw: string): CarrierResult {
  const number = normalizeTmwNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'string') return invalid('TMW Express returned an invalid envelope');
  if (payload.code === 'fail') {
    const message = clean(payload.msg, 80);
    if (message === NOT_FOUND && payload.data == null) throw new NotFoundError(PROVIDER, 'TMW Express does not have this order');
    // The service read no number from the request, which carried one: the request changed.
    if (message === NO_NUMBER) return invalid('TMW Express read no number from the lookup');
    throw new IndeterminateError(PROVIDER, 'TMW Express did not complete the lookup');
  }
  if (payload.code !== 'success' || !isRecord(payload.data)) return invalid('TMW Express returned an unexpected reply');
  const data = payload.data;
  const steps = rowsOf(data, 'airStepList');
  const records = rowsOf(data, 'logisticsrecordList');
  const named = [data.docnewcode, ...steps.map((step) => step.docnewcode)].filter((own) => own != null && own !== '');
  if (named.some((own) => folded(own) !== number)) throw new IndeterminateError(PROVIDER, 'TMW Express answered for another order');

  const scans = [...steps.map(stepScan).filter((scan): scan is Scan => scan !== null), ...records.map(recordScan)].sort(newestFirst);
  // The order is known, but neither its steps nor its courier show anything yet.
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'TMW Express has the order without a step', { reason: 'listed' });
  const events = scans.map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    ...(events[0]!.provider_code ? { provider_code: events[0]!.provider_code } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    events,
  };
}

/** One reply of the lookup: its JSON, or a verification page, or a changed service. */
export function parseTmwReply(body: string, raw: string): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'TMW Express answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'TMW Express answered with a page instead of its tracking JSON', { cause });
  }
  return parseTmw(payload, raw);
}
