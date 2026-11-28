import { normalizeTrackingNumber } from '../../core/detection/index.js';
import {
  ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError,
} from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { caifengStage, statusMap } from './status.js';

export const PROVIDER = 'Caifeng Logistics';
export const CARRIER = 'caifengwl';
// The public sample's reply is under 3 kB.
export const CAIFENG_MAX_BYTES = 256 * 1024;
/** The clock of the firm's branches, all in China. */
export const CAIFENG_ZONE = 'Asia/Shanghai';
// The firm's name on the platform, which every reply for its database gives.
const TENANT = '彩丰物流';

// "0062205239744": the branch, the day the waybill was written and a serial. The site's form sends
// thirteen digits or more to this lookup.
const NUMBER = /^\d{13,20}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2})?)$/;
const MAX_ROWS = 300;
// The platform's answer for a number the firm holds no waybill under.
const NOT_FOUND = /^no$/i;
// The platform refusing the lookup itself: a database it has not opened, or a request it cannot read.
const REFUSED = /尚未开通启用|参数不正常/;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

// A label the platform writes a contact, a truck or a driver after, with its value: "，联系电话:0768-…",
// "，车牌号:粤…，驾驶员:…". The value runs to the next separator.
const LABELLED = /[，,；;]?\s*(?:联系电话|联系方式|电话|手机|车牌号?|驾驶员|司机|签收人|提货人|经办人|联系人)\s*[:：][^，,；;。]*/gu;
// Anything else that reads as a phone number.
const PHONE = /(?<!\d)(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})(?!\d)/gu;
// "车辆已到达彩塘分公司": the branch the truck reached, which the row's department does not name.
const ARRIVED = /^车辆已到达([^，,；;。]{2,40})$/u;

/** A Caifeng Logistics waybill number, as its tracking page takes it. */
export function normalizeCaifengNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Caifeng Logistics waybill numbers are thirteen to twenty digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A row's sentence without the phones, plates and drivers it names. Branch names stay. */
export function caifengWording(sentence: string): string {
  return sentence.replace(LABELLED, '').replace(PHONE, '').replace(/[\s，,；;:：/]+$/u, '').replace(/^[\s，,；;:：/]+/u, '').trim();
}

/** A row's wall clock to the second; a time the calendar has not is a changed reply. */
function wallClock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value.trim()) : null;
  const local = match ? `${match[1]}T${match[2]!.length === 5 ? `${match[2]}:00` : match[2]}` : '';
  // Read in UTC only to check the calendar digits: a clock that does not read back unchanged is not one.
  const parsed = local ? isoTime(local, 'UTC') : null;
  if (!parsed || parsed.iso.slice(0, 19) !== local) return invalid('Caifeng Logistics returned a row without a readable time');
  return local;
}

/** The waybill's rows, which the platform gives as an array or as that array in a JSON string. */
function rowsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON: a changed reply, below.
    }
  }
  return invalid('Caifeng Logistics returned a waybill without rows');
}

interface Scan { readonly local: string; readonly index: number; readonly event: CarrierEvent }

function scan(row: unknown, number: string, index: number, readAt: number): Scan | null {
  if (!isRecord(row)) return invalid('Caifeng Logistics returned an invalid row');
  if (row.bookingnoteno !== undefined && row.bookingnoteno !== null
    && normalizeTrackingNumber(cleanScalar(row.bookingnoteno, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Caifeng Logistics answered with a row of another waybill');
  }
  const local = wallClock(row.operatetime);
  const description = caifengWording(clean(row.content, 600)).slice(0, 300);
  if (!description) return null;
  const code = clean(row.type, 40);
  const department = clean(row.deptname, 80).replace(PHONE, '').trim();
  const location = ARRIVED.exec(description)?.[1] ?? department;
  const staged = caifengStage(code, description);
  const time = isoTime(local, CAIFENG_ZONE);
  return { local, index, event: {
    ...(time && time.timestamp <= readAt + CLOCK_SKEW_MS ? { time: time.iso, time_zone: CAIFENG_ZONE, time_zone_basis: 'carrier' } : {}),
    local_time: local, description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * Reads the platform's reply for one number. A waybill is JSON: the firm's name on the platform
 * (`dbname`), the waybill number (`bookingnoteno_vchr`), the record's parties and goods, and `result`,
 * its rows newest first, each with its waybill, a wall clock (`operatetime`), an operation type, the
 * sentence the site shows and the department that recorded it. A number the firm holds no waybill
 * under gets the bare text `no`. The parties, the goods and the staff who recorded each row are not read.
 */
export function parseCaifeng(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeCaifengNumber(raw);
  const text = body.replace(/^\uFEFF/, '').trim();
  if (NOT_FOUND.test(text)) throw new NotFoundError(PROVIDER, 'Caifeng Logistics has no waybill under this number');
  if (!text.startsWith('{')) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Caifeng Logistics answered with a verification page');
    if (REFUSED.test(text.slice(0, 2_000))) throw new IndeterminateError(PROVIDER, 'Caifeng Logistics did not complete the lookup');
    return invalid('Caifeng Logistics returned a reply that is not JSON');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    return invalid('Caifeng Logistics returned a reply that is not JSON');
  }
  if (!isRecord(reply)) return invalid('Caifeng Logistics returned an invalid reply');
  const tenant = clean(reply.dbname, 40);
  if (!tenant) return invalid('Caifeng Logistics returned a waybill without its company');
  // The platform keeps other firms' databases; a reply under another name is not Caifeng's waybill.
  if (tenant !== TENANT) throw new IndeterminateError(PROVIDER, 'Caifeng Logistics answered with another company\'s waybill');
  if (normalizeTrackingNumber(cleanScalar(reply.bookingnoteno_vchr, 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'Caifeng Logistics answered about another number');
  }
  const rows = rowsOf(reply.result);
  if (rows.length > MAX_ROWS) return invalid('Caifeng Logistics returned an oversized history');
  const seen = new Set<string>();
  const events = rows.flatMap((row, index) => {
    const read = scan(row, number, index, readAt);
    if (!read) return [];
    const key = JSON.stringify([read.local, read.event.provider_code, read.event.description]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [read];
  }).sort((a, b) => (a.local < b.local ? 1 : a.local > b.local ? -1 : a.index - b.index)).map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Caifeng Logistics lists the waybill without a row', { reason: 'listed' });
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
