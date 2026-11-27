import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { sfExpressEventStatus } from '../sf-express/status.js';
import { cyxfxStage, statusMap } from './status.js';

export const PROVIDER = 'C&Y Global Logistics';
export const CARRIER = 'cyxfx';
// A waybill's rows are a few kilobytes; a hand-off row carries the courier's raw route as well.
export const CYXFX_MAX_BYTES = 1024 * 1024;
/** The clock of the warehouses in Aurora, Illinois, where the firm takes parcels in. */
export const CYXFX_HOME = 'America/Chicago';
const CHINA = 'Asia/Shanghai';
// Ten digits on the public samples; the page asks for at least eight characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// "2026/01/09 01:40:21": the wall clock the system writes, without a zone.
const CLOCK = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/;
// SF Express's own route clock: "2026-01-24 20:13:33", China's.
const SF_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// The steps in China: the flight's arrival, customs, and the courier in China. The page draws the courier's
// route under the codes of a hand-off.
const CHINA_CODES = new Set(['8100', '9000', '9500', '110', '11000', '620']);
const CHINA_LABEL = /航班到达|清关|国内/u;
const HANDOFF_CODES = new Set(['110', '11000', '620']);
// "国内开始派送,快递公司:顺丰速运,单号:…": the courier in China and its number.
const HANDOFF = /快递公司\s*[:：]\s*([^,，;；:：\s]{1,20})\s*[,，;；]?\s*单号\s*[:：]\s*([A-Za-z0-9]{8,30})/u;
// Couriers in China a hand-off row may name, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/u, 'sf-express'], [/中通/u, 'zto'], [/圆通/u, 'yto'], [/申通/u, 'sto'], [/韵达/u, 'yunda'], [/京东/u, 'jd-logistics'],
  [/极兔/u, 'j-and-t-cn'], [/德邦/u, 'deppon'], [/邮政|EMS/iu, 'china-post'],
];
// A clause that names a person or gives a phone: a courier, an agent, a signer, a hotline. A number after
// 单号 is a waybill and stays.
const CONTACT = /电话|手机|致电|联系|电联|热线|投诉|呼叫|快递员|快递小哥|投递员|揽投员|揽收员|收寄员|派送员|派件员|收派员|配送员|业务员|司机|姓名|签收人|代收人|收件人|收货人|交给|(?<![A-Z\d])(?<!单号\s*[:：]?\s*)\d{7,}/iu;
// "他人代收：…": who took the parcel in, named or placed after the colon.
const SIGNED = /^(\s*[^,，;；:：]{0,12}?(?:签收|代收))\s*[:：]/u;
const BRACKETED = /[（(][^（）()]{0,200}[）)]/gu;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;
const MAX_ROUTES = 200;
const MAX_TRACE = 512 * 1024;

/** A waybill on C&Y's tracker, without spaces or hyphens. */
export function normalizeCyxfxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'C&Y waybills are 8 to 30 letters and digits');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

/**
 * A row's text without the people and phones it names: a bracket that gives a contact goes, then every
 * clause that names a courier, an agent, a signer or a phone. Who took a parcel in keeps the words that
 * say so, without the name or place after them. "已运抵 待申报" from a row that goes on to give an agent's
 * name and mobile.
 */
export function cyxfxText(value: string): string {
  const text = value.replace(/<[^>]*>/gu, ' ').replace(BRACKETED, (whole) => (CONTACT.test(whole) ? '' : whole));
  const kept: string[] = [];
  // A comma inside a bracketed place ends no clause.
  for (const clause of text.split(/(?<=[，,；;。！!])(?![^【】]*】)/u)) {
    const signed = SIGNED.exec(clause);
    if (signed) kept.push(signed[1]!);
    else if (!CONTACT.test(clause)) kept.push(clause);
  }
  return clean(kept.join(''), 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match
    ? `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}T${match[4]!.padStart(2, '0')}:${match[5]}:${match[6]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
  return value;
}

/** A code as the reply gives it, a string or an integer. */
function code(value: unknown): string {
  if (typeof value === 'string' && /^\d{1,8}$/.test(value.trim())) return value.trim();
  if (Number.isSafeInteger(value) && (value as number) >= 0) return String(value);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a row without its status`);
}

interface Row {
  readonly id: number;
  readonly code: string;
  readonly label: string;
  readonly remark: string;
  readonly local: string;
  readonly trace: string;
}

function row(value: unknown): Row {
  if (!isRecord(value) || !Number.isSafeInteger(value.Logid) || (value.Logid as number) < 0) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
  }
  const trace = typeof value.Thrd_trace === 'string' && value.Thrd_trace.length <= MAX_TRACE ? value.Thrd_trace : '';
  return {
    id: value.Logid as number, code: code(value.Status), label: clean(text(value.Statustext, 60), 60),
    remark: text(value.Remark, 1000).slice(0, 1000), local: wallClock(value.Adddate), trace,
  };
}

/**
 * The waybill the reply gives for the whole number asked, its rows oldest first by the order the system
 * wrote them. `{"ErrorCode":"-1","Msg":"错误的单号"}` is the tracker's answer for a number it does not
 * know; any other error is inconclusive, and a reply for another number is refused.
 */
export function cyxfxRows(payload: unknown, raw: string): Row[] {
  const number = normalizeCyxfxNumber(raw);
  if (!isRecord(payload) || !('ErrorCode' in payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const error = String(payload.ErrorCode).trim();
  if (error !== '0') {
    if (error === '-1' && typeof payload.Msg === 'string' && payload.Msg.trim() === '错误的单号' && !payload.Data) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
    }
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (!Array.isArray(payload.Data) || payload.Data.length > 10) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (!payload.Data.length) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  const waybill = (payload.Data as unknown[]).find((entry) => isRecord(entry) && typeof entry.sn === 'string'
    && normalizeTrackingNumber(entry.sn) === number);
  if (!isRecord(waybill)) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const rows = waybill.rows ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  return (rows as unknown[]).map(row).sort((left, right) => left.id - right.id);
}

interface Handoff {
  readonly carrier: string;
  readonly number: string;
}

/**
 * The courier in China and its number a hand-off row names, when the row names one courier whose own rules
 * offer the number. A number alone names no one.
 */
function handoffOf(entry: Row, number: string): Handoff | null {
  const match = HANDOFF.exec(entry.remark);
  if (!match) return null;
  const onward = normalizeTrackingNumber(match[2]!);
  const named = COURIERS.filter(([name]) => name.test(match[1]!)).map(([, carrier]) => carrier);
  if (named.length !== 1 || onward === number || !(detectCarrierMatch(onward).candidates as string[]).includes(named[0]!)) return null;
  return { carrier: named[0]!, number: onward };
}

interface Route {
  readonly local: string;
  readonly location: string;
  readonly description: string;
  readonly code: string;
}

/**
 * SF Express's route the hand-off row carries, `Response.Body.RouteResponse` with each scan's
 * `_accept_time`, `_accept_address`, `_remark` and `_opcode`, as the page draws it, only when it is the route of the
 * number the row hands the parcel over under. Anything else is not plainly the same parcel, and the row
 * stands alone.
 */
export function sfRoute(trace: string, onward: string): Route[] {
  if (trace.length < 30) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trace);
  } catch {
    return [];
  }
  const response = isRecord(parsed) && isRecord(parsed.Response) ? parsed.Response : null;
  const body = response && isRecord(response.Body) ? response.Body : null;
  const routes = body && isRecord(body.RouteResponse) ? body.RouteResponse : null;
  if (!routes || typeof routes._mailno !== 'string' || normalizeTrackingNumber(routes._mailno) !== onward) return [];
  const listed = Array.isArray(routes.Route) ? routes.Route as unknown[] : isRecord(routes.Route) ? [routes.Route] : [];
  return listed.slice(0, MAX_ROUTES).flatMap((scan) => {
    if (!isRecord(scan) || typeof scan._accept_time !== 'string' || typeof scan._remark !== 'string') return [];
    const clock = SF_CLOCK.exec(scan._accept_time.trim());
    const local = clock ? `${clock[1]}T${clock[2]}` : '';
    if (!clock || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) return [];
    const description = cyxfxText(scan._remark.slice(0, 1000));
    const location = typeof scan._accept_address === 'string' ? clean(scan._accept_address, 60) : '';
    const code = typeof scan._opcode === 'string' && /^\d{1,6}$/.test(scan._opcode.trim()) ? scan._opcode.trim() : '';
    return description ? [{ local, location: CONTACT.test(location) ? '' : location, description, code }] : [];
  });
}

interface Dated {
  readonly order: number;
  readonly tie: number;
  readonly event: CarrierEvent;
}

function dated(local: string, zone: string, basis: string, readAt: number): { order: number; time: Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> } {
  const instant = firstOccurrence(DateTime.fromISO(local, { zone }));
  return {
    order: instant.toMillis(),
    time: instant.toMillis() <= readAt + CLOCK_SKEW_MS
      ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: zone, time_zone_basis: basis } : {},
  };
}

/**
 * C&Y's history for one waybill, newest first: the reply of `api/track/list`, `{ErrorCode, Msg, Data}`, with
 * the waybill's rows oldest first, each a status code, its label, a remark and a wall clock without a zone.
 * The rows until the flight lands in China are on the clock of the warehouses in Aurora, Illinois, the
 * firm's; from the flight's arrival on, they are on China's, where the parcel clears customs and a courier
 * delivers it. A zone that would date a row after the lookup leaves it its wall clock alone. The recipient's
 * name and address and the agents a remark names are never read. The courier a hand-off row names becomes the
 * delivery carrier, with its number; SF Express's route that the row carries for that number adds its scans.
 */
export function parseCyxfx(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeCyxfxNumber(raw);
  const rows = cyxfxRows(payload, number);
  const arrival = rows.findIndex((entry) => CHINA_CODES.has(entry.code) || CHINA_LABEL.test(entry.label));
  const seen = new Set<string>();
  const read: Dated[] = [];
  let handoff: Handoff | null = null;
  for (const [index, entry] of rows.entries()) {
    const description = cyxfxText(entry.remark) || entry.label;
    if (!description) continue;
    const key = JSON.stringify([entry.local, entry.code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const china = arrival >= 0 && index >= arrival;
    const { order, time } = dated(entry.local, china ? CHINA : CYXFX_HOME, china ? 'destination' : 'carrier', readAt);
    const staged = cyxfxStage(description, entry.code, entry.label);
    read.push({ order, tie: index, event: {
      ...time, local_time: entry.local, description, provider_code: entry.code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
    const named = HANDOFF_CODES.has(entry.code) ? handoffOf(entry, number) : null;
    if (!named) continue;
    handoff = named;
    if (named.carrier !== 'sf-express') continue;
    for (const [at, scan] of sfRoute(entry.trace, named.number).entries()) {
      const routed = dated(scan.local, CHINA, 'destination', readAt);
      // SF's operation code is SF's stage; C&Y's codes mean other things, so it is not kept as the scan's code.
      const coded = scan.code ? sfExpressEventStatus(scan.code, '', scan.description) : undefined;
      const worded = coded ? { stage: coded.stage, source: 'carrier_map' } : classifyWording(scan.description, 'in_transit');
      read.push({ order: routed.order, tie: index + (at + 1) / (MAX_ROUTES + 1), event: {
        ...routed.time, local_time: scan.local, ...(scan.location ? { location: scan.location } : {}), description: scan.description,
        ...(worded.source !== 'none' ? { stage: worded.stage, stage_source: worded.source } : {}),
      } });
    }
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  const events = read.sort((left, right) => right.order - left.order || right.tie - left.tie).map((entry) => entry.event);
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
    ...(arrival >= 0 || handoff ? { destination_country: 'CN' } : {}),
    ...(handoff ? { delivery_carrier: handoff.carrier, delivery_tracking_number: handoff.number } : {}),
    events,
  };
}
