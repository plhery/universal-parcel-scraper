import { ztoFreightWaybill } from '../../core/detection/ztoFreight.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { ztoFreightStage } from './status.js';

export const PROVIDER = 'ZTO Freight';
export const ZTO_FREIGHT_ENDPOINT = 'https://www.zto56.com/api/qry/ewb_info';
export const ZTO_FREIGHT_ORIGIN = 'https://www.zto56.com';
export const ZTO_FREIGHT_PAGE = `${ZTO_FREIGHT_ORIGIN}/billsearch.html`;
// Bot checks a CDN or a cloud firewall could put in place of the reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

export function normalizeZtoFreightNumber(raw: string): string {
  const number = ztoFreightWaybill(raw);
  if (!number) throw new InvalidInputError(PROVIDER);
  return number;
}

export function ztoFreightJson(text: string): unknown {
  if (/^\s*</.test(text)) {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'ZTO Freight answered with a browser check');
    throw new SchemaError(PROVIDER, 'ZTO Freight returned a page instead of its tracking reply');
  }
  try { return JSON.parse(text) as unknown; }
  catch { throw new SchemaError(PROVIDER, 'ZTO Freight returned a reply that is not JSON'); }
}

function clock(raw: unknown): string {
  const match = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(raw.trim());
  const day = match && calendarDay(+match[1]!, +match[2]!, +match[3]!);
  if (!match || !day) throw new SchemaError(PROVIDER, 'ZTO Freight returned an invalid scan clock');
  return `${day}T${match[4]}`;
}

const text = (value: unknown): string => (typeof value === 'string' ? clean(value) : '');

/**
 * A scan's wording from its type and the branches it names. The carrier's own `desc` carries
 * couriers' names and phone numbers, so it is read only for the reason of a problem scan.
 */
function wording(scan: Record<string, unknown>, type: string): string {
  const site = text(scan.scanSite), next = text(scan.preOrNextSite);
  if (type === '揽收' || type === '收件') return site ? `${site} 已揽收` : '已揽收';
  if (type === '发件' || type === '发车') return next ? `${site || '网点'} 发往 ${next}` : `${site} ${type}`.trim();
  if (type === '到件' || type === '到车') return site ? `已到达 ${site}` : type;
  if (type === '派件') return site ? `${site} 正在派件` : '正在派件';
  if (type === '签收') return site ? `${site} 已签收` : '已签收';
  if (type === '问题件') {
    const reason = /原因是【([^】]{1,80})】/.exec(text(scan.desc))?.[1];
    return reason ? `问题件 · ${clean(reason)}` : '问题件';
  }
  return site ? `${type} · ${site}` : type;
}

function entries(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data) || data.length > 10) throw new SchemaError(PROVIDER, 'ZTO Freight returned an invalid waybill list');
  return data.map(item => {
    let row: unknown = item;
    if (typeof item === 'string') {
      try { row = JSON.parse(item) as unknown; }
      catch { throw new SchemaError(PROVIDER, 'ZTO Freight returned a waybill that is not JSON'); }
    }
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'ZTO Freight returned an invalid waybill');
    return row;
  });
}

export function parseZtoFreight(payload: unknown, raw: string): CarrierResult {
  const number = normalizeZtoFreightNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.meta)) throw new SchemaError(PROVIDER, 'ZTO Freight returned no tracking envelope');
  if (payload.meta.success !== true) {
    const message = text(payload.meta.message);
    if (/频繁|too many|limit/i.test(message)) throw new RateLimitedError(PROVIDER);
    if (/验证|captcha/i.test(message)) throw new ChallengeError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'ZTO Freight did not complete the lookup');
  }
  const data = payload.data;
  // The tracker leaves `data` out for a waybill it does not hold, and answers a number its own
  // rule refuses with a sentence instead of a list.
  if (data == null || Array.isArray(data) && !data.length) throw new NotFoundError(PROVIDER);
  if (typeof data === 'string') {
    if (/不符合规则/.test(data)) throw new NotFoundError(PROVIDER, 'ZTO Freight does not issue this waybill');
    throw new IndeterminateError(PROVIDER, 'ZTO Freight did not complete the lookup');
  }
  const rows = entries(data).filter(row => row.billCode === number);
  if (rows.length !== 1) throw new SchemaError(PROVIDER, 'ZTO Freight returned another waybill');
  const row = rows[0]!;
  if (row.traces === '' || Array.isArray(row.traces) && !row.traces.length) {
    // A held waybill without scans still names its cities or order state; an unknown one names nothing.
    if ([row.sendCity, row.receiptCity, row.orderStatus].some(value => text(value))) throw new NoHistoryError(PROVIDER);
    throw new NotFoundError(PROVIDER);
  }
  if (!Array.isArray(row.traces) || row.traces.length > 2000) throw new SchemaError(PROVIDER, 'ZTO Freight returned an invalid scan list');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const scan of row.traces) {
    if (!isRecord(scan) || typeof scan.scanType !== 'string' || !text(scan.scanType) || text(scan.scanType).length > 32) {
      throw new SchemaError(PROVIDER, 'ZTO Freight returned an invalid scan');
    }
    const type = text(scan.scanType), stage = ztoFreightStage(type);
    const location = text(scan.scanCity);
    const event: CarrierEvent = { local_time: clock(scan.scanDate), provider_code: type, description: wording(scan, type),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // The tracker lists scans oldest first; a later scan can carry an earlier clock.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof ztoFreightStage>;
  const eta = stage !== 'delivered' && typeof row.predictTime === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.predictTime.trim());
  const expected = eta ? calendarDay(+eta[1]!, +eta[2]!, +eta[3]!) : null;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: expected ?? null,
    events: events.slice(0, 200) };
}
