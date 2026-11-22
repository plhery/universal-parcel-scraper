import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { benniaoStage } from './status.js';

export const PROVIDER = 'Benniao Express';
export const BENNIAO_ORIGIN = 'https://www.benniaosuyun.com';
/** The page the site's waybill search opens, whose script asks the endpoint below. */
export const BENNIAO_PAGE = `${BENNIAO_ORIGIN}/?search/`;
export const BENNIAO_ENDPOINT = 'https://bnsy.benniaosuyun.com/api/officialWebSitePortal/findWaybillTrack';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** BN and fourteen digits, as Benniao's labels and the waybills kuaidi.com lists are; the endpoint answers without the BN. */
export function normalizeBenniaoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  const digits = /^(?:BN)?(\d{14})$/.exec(number)?.[1];
  if (!digits) throw new InvalidInputError(PROVIDER, 'Benniao waybills are BN and fourteen digits');
  return `BN${digits}`;
}

/** The endpoint's JSON, or the failure a page in its place stands for. */
export function benniaoJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Benniao answered with a browser check');
    throw new SchemaError(PROVIDER, 'Benniao returned an invalid reply');
  }
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? textFromHtml(value, max) : '');

/**
 * A row's wording without the phone numbers its branches carry, the courier, the signatory or
 * the customer service notice.
 */
function wording(message: string): string {
  return message
    .replace(/[（(]物流问题[^）)]{0,80}[）)]/g, '')
    .replace(/\(\s*[\d\s-]{7,20}\)/g, '')
    .replace(/[，,]\s*派件员是【[^】]{0,40}】/g, '')
    .replace(/[，,]\s*签收人是【[^】]{0,40}】/g, '')
    .replace(/[，,]\s*上一站是【\s*】/g, '')
    .replace(/1[3-9]\d{9}|\d{3,4}-\d{7,8}|400\d{7}/g, '')
    .replace(/[\s,，:：]+$/, '')
    .trim();
}

/** The scan a row stands for, as 已到达 or 已操作拦截扫描. */
function code(description: string): string | undefined {
  return /已(?:揽收|发件|到达|派件|签收|操作[一-鿿]{1,6}扫描)/.exec(description.replace(/【[^】]*】/g, ''))?.[0];
}

/**
 * The scans the endpoint gives for one waybill, oldest first, each with its China wall clock,
 * its city and its wording. The reply must name the whole waybill asked, without its BN.
 */
export function parseBenniao(body: unknown, raw: string): CarrierResult {
  const number = normalizeBenniaoNumber(raw), digits = number.slice(2);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SchemaError(PROVIDER, 'Benniao returned an invalid reply');
  const { success, code: status, msg, result } = body as Record<string, unknown>;
  if (success !== true || status !== 200) {
    const reason = text(msg, 120);
    // The page signs each request; a refused signature means its scheme changed.
    if (/验签|签名/.test(reason)) throw new ChallengeError(PROVIDER, 'Benniao refused the search page\'s signature');
    if (/频繁|太快|过多/.test(reason)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Benniao did not complete the lookup');
  }
  if (!Array.isArray(result) || result.length !== 1 || !result[0] || typeof result[0] !== 'object') {
    throw new SchemaError(PROVIDER, 'Benniao returned an invalid result');
  }
  const { waybillNum, waybillStateInfo } = result[0] as Record<string, unknown>;
  if (waybillNum !== digits) throw new SchemaError(PROVIDER, 'Benniao returned another waybill');
  if (waybillStateInfo === null || (Array.isArray(waybillStateInfo) && !waybillStateInfo.length)) throw new NotFoundError(PROVIDER);
  if (!Array.isArray(waybillStateInfo) || waybillStateInfo.length > 500) throw new SchemaError(PROVIDER, 'Benniao returned an invalid history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of waybillStateInfo as unknown[]) {
    if (!row || typeof row !== 'object') throw new SchemaError(PROVIDER, 'Benniao returned an invalid history row');
    const { date: stamp, location: city, msg: message } = row as Record<string, unknown>;
    const clock = typeof stamp === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(stamp) : null;
    const date = clock && calendarDay(+clock[1]!, +clock[2]!, +clock[3]!);
    if (!clock || !date) throw new SchemaError(PROVIDER, 'Benniao returned an invalid scan time');
    const description = wording(text(message, 400));
    if (!description) continue;
    const type = code(description), stage = type ? benniaoStage(type) : undefined, location = text(city, 40);
    const event: CarrierEvent = { local_time: `${date}T${clock[4]}`, description, ...(type ? { provider_code: type } : {}),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // Newest first; rows on the same clock keep the endpoint's order reversed.
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!;
  const stage = newest.stage as ReturnType<typeof benniaoStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
