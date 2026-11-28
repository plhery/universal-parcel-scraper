import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap, xydwlStage } from './status.js';

export const PROVIDER = 'Xinyuda Logistics';
export const CARRIER = 'xydwl';
// One waybill's rows are a kilobyte or two.
export const XYDWL_MAX_BYTES = 256 * 1024;
/** Every row is keyed in China by the firm's staff, on China's clock. */
export const XYDWL_ZONE = 'Asia/Shanghai';

// Digits, or letters and digits with a digit: seven digits on the samples.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z][A-Z0-9_]{0,40}$/;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The signer the delivery row names in brackets: 货物已被【…】签收.
const SIGNER = /已被【[^【】]{0,40}】签收/gu;
// A person or a phone a row gives after a label: 签收人：…, 司机【…】.
const LABELLED = /[，,；;\s]*(?:签收人|收货人|收件人|提货人|联系人|司机|驾驶员|车牌号?|(?:联系)?电话|手机(?:号码?)?)\s*(?:【[^【】]{0,40}】|[:：]\s*[^，,；;。\s]{1,20})/gu;
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)0\d{2,3}-?\d{7,8}(?!\d)/u;
const MAX_ROWS = 300;

/** A Xinyuda waybill, without spaces or hyphens. */
export function normalizeXydwlNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Xinyuda Logistics waybills are 5 to 30 letters and digits');
  return number;
}

/** The lookup's body: the number alone, as the site's result page sends it. */
export const xydwlRequestBody = (number: string): string => JSON.stringify({ waybillCode: number });

/** A row's wording, without the signer, a driver or a phone it names. */
export function xydwlText(value: string): string {
  const text = clean(value, 2000).replace(SIGNER, '已被签收').replace(LABELLED, '');
  const phone = PHONE.exec(text);
  return clean(phone ? text.slice(0, phone.index) : text, 300).replace(/^[\s,，;；:：。]+|[\s,，;；:：。]+$/gu, '');
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  return local;
}

/**
 * The waybill's rows, newest first. Each keeps its wall clock in `local_time`, dated on China's
 * clock with `carrier` as the basis; a clock that would date a row after the read keeps its wall
 * clock alone. Rows at one clock keep the reply's order, a repeated row is read once, and a row
 * whose waybill is not the number asked is a changed reply.
 */
function scans(rows: readonly unknown[], number: string, readAt: number): CarrierEvent[] {
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const seen = new Set<string>();
  const read: { local: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || typeof row.trackValue !== 'string') throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    if (normalizeTrackingNumber(clean(row.waybillNo, 64)) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
    const local = wallClock(row.trackTime);
    const description = xydwlText(row.trackValue);
    if (!description) continue;
    const code = typeof row.templateNode === 'string' && CODE.test(row.templateNode) ? row.templateNode : '';
    const key = JSON.stringify([local, code, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = isoTime(local, XYDWL_ZONE);
    const staged = xydwlStage(code, description);
    read.push({ local, index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: XYDWL_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, description, ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  return read.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map((scan) => scan.event);
}

/** The reply's JSON. A bot check in its place is a challenge, anything else a changed reply. */
export function xydwlJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  }
}

/**
 * A waybill's history from the tracker's `getOutSideTracks` reply, `{msg, code, list}`, whose
 * `list` keys each waybill found to its rows. A successful reply without the number asked in
 * `list` is the tracker's answer that it holds no waybill under it; any other code is inconclusive.
 * Who keyed each row is not read.
 */
export function parseXydwl(payload: unknown, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeXydwlNumber(raw);
  if (!isRecord(payload) || !('code' in payload)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  if (payload.code !== 0) throw new IndeterminateError(PROVIDER, `${PROVIDER} did not complete the lookup`);
  if (!isRecord(payload.list)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid reply`);
  const keys = Object.keys(payload.list);
  if (keys.some((key) => normalizeTrackingNumber(key) !== number)) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  if (!keys.length) throw new NotFoundError(PROVIDER, `${PROVIDER} has no waybill under this number`);
  const rows = payload.list[keys[0]!];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  const events = scans(rows, number, readAt);
  if (!events.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the waybill without a row`, { reason: 'listed' });
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
