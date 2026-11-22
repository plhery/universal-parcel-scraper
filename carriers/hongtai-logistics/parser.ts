import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { hongtaiStage } from './status.js';

export const PROVIDER = 'Hongtai Logistics';
/** The site's waybill search, whose script asks the endpoint below. */
export const HONGTAI_PAGE = 'https://www.ht56.com/orderSearch.html';
export const HONGTAI_ENDPOINT = 'https://www.ht56.com/tms-htwl/tmsOpenApi/selectEventRouteForeignByOrderNo';
const ZONE = 'Asia/Shanghai';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// Scans after 2015 and before 2100: anything else is a changed reply.
const EARLIEST = Date.UTC(2015, 0, 1), LATEST = Date.UTC(2100, 0, 1);

/** The waybills on Hongtai's pages and the ones kuaidi.com lists are nine digits. */
export function normalizeHongtaiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{9}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Hongtai waybills are nine digits');
  return number;
}

/** The endpoint's JSON, or the failure a page in its place stands for. */
export function hongtaiJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Hongtai answered with a browser check');
    throw new SchemaError(PROVIDER, 'Hongtai returned an invalid reply');
  }
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? textFromHtml(value, max) : '');

/**
 * A scan's wording from its log, without the phone numbers, plates, drivers and load numbers it
 * carries, or the signatory's name. Branch names and a transfer's partner, waybill and station stay.
 */
function wording(log: string): string {
  return log
    .replace(/【\s*联系(?:电话|方式)\s*[:：]?[^】]{0,60}】/g, '')
    .replace(/联系(?:电话|方式)【[^】]{0,60}】/g, '')
    .replace(/[，,]?\s*车牌号【[^】]{0,20}】/g, '')
    .replace(/驾驶员【[^】]{0,20}】/g, '')
    .replace(/装车编号【[^】]{0,60}】/g, '')
    .replace(/[，,]?\s*运单号【[^】]{0,40}】/g, '')
    .replace(/^货物已由【[^】]{0,40}】签收$/, '货物已签收')
    .replace(/1[3-9]\d{9}/g, '')
    .replace(/[，,\s]+$/, '')
    .trim();
}

/**
 * The route the endpoint gives for one waybill: its scans, oldest first, each with its node's
 * name, its branch and its instant in epoch milliseconds, which the adapter checks against the
 * row's China wall clock. Every row must be the whole waybill asked.
 */
export function parseHongtai(body: unknown, raw: string): CarrierResult {
  const number = normalizeHongtaiNumber(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SchemaError(PROVIDER, 'Hongtai returned an invalid reply');
  const { code, msg, rows } = body as Record<string, unknown>;
  const message = text(msg, 120);
  if (code !== '200') {
    if (/频繁|太快|过多/.test(message)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Hongtai did not complete the lookup');
  }
  if (!Array.isArray(rows) || rows.length > 500) throw new SchemaError(PROVIDER, 'Hongtai returned an invalid route');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const events: { millis: number; event: CarrierEvent }[] = [], seen = new Set<string>();
  for (const row of rows as unknown[]) {
    if (!row || typeof row !== 'object') throw new SchemaError(PROVIDER, 'Hongtai returned an invalid route row');
    const { eventNo, eventTime, eventTimeStr, eventNodeValue, deptName, eventLog } = row as Record<string, unknown>;
    if (eventNo !== number) throw new SchemaError(PROVIDER, 'Hongtai returned another waybill');
    if (typeof eventTime !== 'number' || !Number.isSafeInteger(eventTime) || eventTime < EARLIEST || eventTime >= LATEST) {
      throw new SchemaError(PROVIDER, 'Hongtai returned an invalid scan time');
    }
    const instant = DateTime.fromMillis(Math.floor(eventTime / 1000) * 1000, { zone: ZONE });
    if (instant.toFormat('yyyy-MM-dd HH:mm:ss') !== eventTimeStr) throw new SchemaError(PROVIDER, 'Hongtai returned a scan time that disagrees with its clock');
    const node = text(eventNodeValue, 40), location = text(deptName, 80);
    const description = wording(text(eventLog, 400)) || node;
    if (!description) continue;
    const stage = node ? hongtaiStage(node) : undefined;
    const event: CarrierEvent = { time: instant.toISO({ suppressMilliseconds: true })!, description, ...(node ? { provider_code: node } : {}),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push({ millis: instant.toMillis(), event }); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // Newest first; rows at the same instant keep the endpoint's order reversed.
  const sorted = events.reverse().sort((a, b) => b.millis - a.millis).map(({ event }) => event);
  const newest = sorted.find(event => event.stage === 'delivered') ?? sorted[0]!;
  const stage = newest.stage as ReturnType<typeof hongtaiStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: newest.time!, events: sorted.slice(0, 200) };
}
