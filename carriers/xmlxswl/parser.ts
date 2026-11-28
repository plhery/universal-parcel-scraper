import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { lqfastWording } from '../anjiexin56/lqfast.js';
import { lxsStage, statusMap } from './status.js';

export const PROVIDER = 'Longxinshun Logistics';
export const CARRIER = 'xmlxswl';
// The public sample's reply is a few hundred bytes.
export const LXS_MAX_BYTES = 256 * 1024;
/** The clock of the firm's branches, all in China. */
export const LXS_ZONE = 'Asia/Shanghai';

// Digits alone: the platform matches the number against a whole-number column and answers letters with a database error.
const NUMBER = /^\d{5,18}$/;
// A refusal, written as a script literal rather than JSON: {status:1,msg:'…'}.
const REFUSAL = /^\{\s*status\s*:\s*(\d{1,4})\s*,\s*msg\s*:\s*'([^']{0,500})'/;
// The platform's answer for a number the firm holds no waybill under, naming the number.
const NOT_FOUND = /^当前查询的单号[：:]\s*([0-9A-Za-z]{1,40})\s*不存在[!！]?$/u;
// A row's date as the platform writes it, 2023/11/4, perhaps with a clock after it.
const BILL_DATE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const MAX_ROWS = 300;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|安全威胁|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** A Longxinshun waybill number, without spaces or hyphens. */
export function normalizeLxsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Longxinshun Logistics waybill numbers are five to eighteen digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const pad = (value: string) => value.padStart(2, '0');

/** A row's day, or its wall clock to the second when the row gives one; a date the calendar has not is a changed reply. */
function rowClock(value: unknown): { local: string; timed: boolean } {
  const match = typeof value === 'string' ? BILL_DATE.exec(value.trim()) : null;
  if (!match) return invalid('Longxinshun Logistics returned a row without a readable date');
  const [, year, month, day, hour, minute, second] = match;
  const date = `${year}-${pad(month!)}-${pad(day!)}`;
  const local = hour === undefined ? date : `${date}T${pad(hour)}:${minute}:${second ?? '00'}`;
  // Read in UTC only to check the calendar digits: a date that does not read back unchanged is not one.
  const probe = hour === undefined ? `${date}T00:00:00` : local;
  const parsed = isoTime(probe, 'UTC');
  if (!parsed || parsed.iso.slice(0, 19) !== probe) return invalid('Longxinshun Logistics returned an invalid scan date');
  return { local, timed: hour !== undefined };
}

/** The reply as a record: JSON for a waybill, a script literal for a refusal. */
function payloadOf(body: string, number: string): Record<string, unknown> {
  const text = body.replace(/^\uFEFF/, '').trim();
  const refusal = REFUSAL.exec(text);
  let payload: unknown;
  if (refusal) payload = { status: Number(refusal[1]), msg: refusal[2] };
  else {
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Longxinshun Logistics answered with a verification page', { cause });
      throw new SchemaError(PROVIDER, 'Longxinshun Logistics returned a reply that is not its tracking result', { cause });
    }
  }
  if (!isRecord(payload)) return invalid('Longxinshun Logistics returned an invalid reply');
  if (typeof payload.status === 'number' && payload.status > 0) {
    const message = typeof payload.msg === 'string' ? clean(payload.msg, 200) : '';
    const missing = NOT_FOUND.exec(message);
    if (missing && normalizeTrackingNumber(missing[1]!) === number) throw new NotFoundError(PROVIDER, 'Longxinshun Logistics has no waybill under this number');
    // A notice about another number, or any other refusal, such as a database error, settles nothing.
    throw new IndeterminateError(PROVIDER, 'Longxinshun Logistics did not complete the lookup');
  }
  return payload;
}

/**
 * Reads the platform's reply for one number under the firm's company id. A waybill's reply is
 * `{"track":[{billdate, content}, …]}`, oldest first, each row dated by its day; a number the firm
 * holds no waybill under gets `{status:1,msg:'当前查询的单号：…不存在!'}`, naming it. A waybill's reply
 * does not repeat the number. The truck the platform may add (`Table1`) is not read.
 */
export function parseLxs(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeLxsNumber(raw);
  const payload = payloadOf(body, number);
  const rows = payload.track;
  if (!Array.isArray(rows)) return invalid('Longxinshun Logistics returned a reply without its tracking rows');
  if (rows.length > MAX_ROWS) return invalid('Longxinshun Logistics returned an oversized history');
  const seen = new Set<string>();
  const scans: { day: string; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row) || (row.content !== null && row.content !== undefined && typeof row.content !== 'string')) {
      return invalid('Longxinshun Logistics returned an invalid row');
    }
    const { local, timed } = rowClock(row.billdate);
    const { description, location } = lqfastWording(typeof row.content === 'string' ? row.content.slice(0, 2000) : '');
    if (!description) continue;
    const key = JSON.stringify([local, location, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const time = timed ? isoTime(local, LXS_ZONE) : null;
    const staged = lxsStage(description);
    scans.push({ day: local.slice(0, 10), index, event: {
      ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: LXS_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, ...(location ? { location } : {}), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'Longxinshun Logistics lists the waybill without a row', { reason: 'listed' });
  // Newest day first; rows of one day keep the reply's order, reversed.
  const events = scans.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.index - a.index)).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    events,
  };
}
