import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { chinastarStage, statusMap } from './status.js';

export const PROVIDER = 'Huaxin Supply Chain';
export const CARRIER = 'chinastarlogistics';
// A waybill's history is a few kilobytes.
export const CHINASTAR_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit: Y, the office, S, a date and a sequence for a waybill, ten digits for the
// shipper's order the tracker also finds a waybill by.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// The site sends numbers starting 00 to its old system instead.
const OLD_SYSTEM = /^00/;
const ZONE = 'Asia/Shanghai';
// The service's answer for a number it holds nothing under: "暂无数据，非常抱歉，您的订单将会加急处理！".
const NO_DATA = /^暂无数据/u;
// "2023-04-17 18:31:31": the clock the system writes, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// Where the row's own text gives its status, after the operator's name and the clock: "状态： [ 已发运 ]".
const STATUS = /状态\s*[：:]/u;
// A status text that names a person or gives a phone is not shown: the node's name is.
const PERSON = /操作人|调度员|司机|签收人|收货人|联系人|电话|手机|(?<!\d)1[3-9]\d{9}(?!\d)/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

/** A number on Huaxin's tracker, without spaces or hyphens. */
export function normalizeChinastarNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Huaxin numbers are 6 to 40 letters and digits');
  if (OLD_SYSTEM.test(number)) throw new InvalidInputError(PROVIDER, 'Huaxin tracks numbers starting 00 on its old system, which this adapter does not read');
  return number;
}

/** A reply that is not the tracker's JSON: a browser check, or a changed route. */
export function notJson(body: string): never {
  if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a reply that is not its tracking JSON`);
}

function text(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' || value.length > maxLength * 4) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid node`);
  return clean(value, maxLength);
}

/** A node's wall clock, to the second, checked against the calendar. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid node time`);
  }
  return local;
}

/**
 * The status a node's text gives after its last `状态：`, without the brackets around its parts:
 * "从：华欣石家庄仓库中转发往华欣北分仓库". The operator's name and the clock before it are left out,
 * and a text with none, or one that names a person or a phone, gives nothing.
 */
export function chinastarStatusText(content: string): string {
  const parts = content.split(STATUS);
  if (parts.length < 2) return '';
  const status = clean(parts.at(-1)!.replace(/\s*[[\]]\s*/gu, ''), 120);
  return PERSON.test(status) ? '' : status;
}

interface Node {
  readonly waybill: string;
  readonly order: string;
  readonly local: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly location: string;
}

function node(value: unknown): Node {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid node`);
  const waybill = typeof value.logisticsOrderNo === 'string' ? normalizeTrackingNumber(value.logisticsOrderNo) : '';
  if (!waybill || waybill.length > 64) throw new SchemaError(PROVIDER, `${PROVIDER} returned a node without its waybill`);
  const order = typeof value.customerOrderNumber === 'string' ? normalizeTrackingNumber(value.customerOrderNumber) : '';
  const code = value.linkNodeCode === null || value.linkNodeCode === undefined ? '' : value.linkNodeCode;
  if (typeof code !== 'string' || !/^\d{0,6}$/.test(code)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid node`);
  const name = text(value.linkNodeName, 40);
  return {
    waybill, order, local: wallClock(value.operationTime), code, name,
    description: chinastarStatusText(text(value.contentDescription, 300)) || name,
    location: text(value.operationPosition, 80),
  };
}

/**
 * The nodes of one waybill for the number asked, and that waybill. The tracker finds a waybill by its
 * own number or by the shipper's order number, so every node must carry the number asked as one or the
 * other; a reply with another number's node is refused whole. An order with several waybills names no
 * one parcel.
 */
export function chinastarNodes(payload: unknown, raw: string): { waybill: string; nodes: Node[] } {
  const number = normalizeChinastarNumber(raw);
  if (!isRecord(payload) || typeof payload.status !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  // The page gives up on any other status: the lookup did not complete.
  if (payload.status !== '0') throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (payload.data === null || payload.data === undefined) {
    if (typeof payload.message === 'string' && NO_DATA.test(payload.message)) {
      throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
    }
    throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  }
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.data.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, `${PROVIDER} listed no node for the number`);
  const nodes = (payload.data as unknown[]).map(node);
  if (nodes.some((entry) => entry.waybill !== number && entry.order !== number)) {
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with another number's node`);
  }
  const waybills = new Set(nodes.map((entry) => entry.waybill));
  if (waybills.has(number)) return { waybill: number, nodes: nodes.filter((entry) => entry.waybill === number) };
  if (waybills.size > 1) throw new IndeterminateError(PROVIDER, `${PROVIDER} lists several waybills under the order`, { reason: 'several_parcels' });
  return { waybill: [...waybills][0]!, nodes };
}

/**
 * Huaxin's history for one waybill, newest first: the reply of `golbalLinkNodeGwAndFast100`,
 * `{status, message, errorList, data}`, with the waybill's nodes newest first. Each node gives
 * its step's code and name, the operator's place, a clock without a zone, on China's, and a text
 * that repeats the operator's name and the clock before the status. The status is the wording;
 * the operator, the signer and the signature picture are left out. Looked up by the shipper's
 * order, the result names the waybill as its canonical number.
 */
export function parseChinastar(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeChinastarNumber(raw);
  const { waybill, nodes } = chinastarNodes(payload, number);
  const seen = new Set<string>();
  const rows: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, entry] of nodes.entries()) {
    if (!entry.description) continue;
    const key = JSON.stringify([entry.local, entry.code, entry.description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(entry.local, { zone: ZONE }));
    const staged = chinastarStage(entry.code, entry.name, entry.description);
    rows.push({ local: entry.local, index, event: {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: entry.local,
      ...(entry.location ? { location: entry.location } : {}),
      description: entry.description,
      ...(entry.code ? { provider_code: entry.code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first; nodes at one clock keep the reply's order, which lists the newer first.
  const events = rows.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((row) => row.event);
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
    ...(waybill !== number ? { canonical_tracking_number: waybill } : {}),
    events,
  };
}
