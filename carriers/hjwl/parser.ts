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
import { hjwlStage, statusMap } from './status.js';

export const PROVIDER = 'HJWL';
export const CARRIER = 'hjwl';
// A parcel's history is a kilobyte or two.
export const HJWL_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: HJWL and fourteen digits on the public sample. Never empty: the
// service would read a request without a number as a request for every node.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
const ZONE = 'Asia/Shanghai';
// The success message of the framework the service runs on.
const DONE = '操作成功';
// "2023-06-13 18:23:46": the clock the operator entered, without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// A courier's name and phone after their role, "快递员<name>，联系电话<phone>", or the same in brackets.
const COURIER = /([（(])?(快递员|揽收员|揽件员|派送员|派件员|配送员|快递小哥|司机)[:：]?\s*[^\s，,。；;：:（()）【】]{1,4}[，,]\s*(?:联系电话|联系方式|电话|手机(?:号码?)?)[:：]?\s*[\d*\- ]{6,20}\d[）)]?/gu;
// A signatory, "由<name>签收".
const SIGNATORY = /由[^，,。；;【】]{1,20}签收/gu;
// Anything else that names a person or a phone: the wording stops before it.
const CONTACT = /签收人|收件人|联系人|(?:联系)?(?:电话|手机)(?:号码?)?[:：]?\s*\d|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{3,4}-\d{7,8}(?!\d)/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 200;

/** A waybill on HJWL's tracker, without spaces or hyphens. */
export function normalizeHjwlNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HJWL waybills are 6 to 40 letters and digits');
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

/** A node's wording, without a courier's name and phone or a signatory: the wording stops before any other contact. */
export function hjwlWording(message: string): string {
  const named = message.replace(COURIER, (_match, bracket: string | undefined, role: string) => (bracket ? '' : role)).replace(SIGNATORY, '签收');
  const contact = CONTACT.exec(named);
  return (contact ? named.slice(0, contact.index) : named).replace(/[\s，,；;：:（(]+$/u, '').trim();
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
 * HJWL's history for one waybill, newest first: the reply of
 * `GET /api/logisticsNodes/findByNumber?number=`, `{code, success, data, msg}`, with the
 * nodes oldest first, each the number, a short status, a message and `createTime`. Every
 * node must be the whole number asked: a reply with another number's node is refused, since
 * a service that ignored the number would list every parcel's nodes. The operator enters
 * each node by hand with its clock, which has no zone and is dated on China's clock.
 */
export function parseHjwl(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHjwlNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== 200 || payload.success !== true) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  // The service's answer for a number it holds no node under: success and no node.
  if (payload.data.length === 0) {
    if (payload.msg !== DONE) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
    throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  }
  if (payload.data.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);

  const seen = new Set<string>();
  const rows: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, node] of (payload.data as unknown[]).entries()) {
    if (!isRecord(node) || typeof node.number !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid node`);
    if (normalizeTrackingNumber(node.number) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered with another number's node`);
    const local = wallClock(node.createTime);
    const status = text(node.status, 40);
    const description = hjwlWording(text(node.message, 300)) || status;
    if (!description) continue;
    const key = JSON.stringify([local, status, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = hjwlStage(status, description);
    rows.push({ local, index, event: {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, description,
      ...(status ? { provider_code: status } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!rows.length) throw new NoHistoryError(PROVIDER);
  // Newest first; nodes at one clock keep the reply's order, which lists the newer last.
  const events = rows.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : right.index - left.index))
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
    events,
  };
}
