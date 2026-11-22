import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { riyuStage } from './status.js';

export const PROVIDER = 'Riyu Logistics';
export const RIYU_ORIGIN = 'https://www.rywl.cn';
/** The site's 货物追踪 page for a waybill, whose script asks the endpoint below. */
export const riyuPage = (number: string) => `${RIYU_ORIGIN}/cargoMap-${encodeURIComponent(number)}`;
export const RIYU_ENDPOINT = `${RIYU_ORIGIN}/ssm/order/orderTrack`;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** The waybills on kuaidi.com's Riyu page are a letter and ten digits, the eleven characters the site's search box takes. */
export function normalizeRiyuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z]\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Riyu waybills are a letter and ten digits');
  return number;
}

export function riyuLookupUrl(number: string): string {
  return `${RIYU_ENDPOINT}?${new URLSearchParams({ omsNo: number })}`;
}

/** The endpoint's JSON, or the failure a page in its place stands for. */
export function riyuJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Riyu answered with a browser check');
    throw new SchemaError(PROVIDER, 'Riyu returned an invalid reply');
  }
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? textFromHtml(value, max) : '');

/**
 * The route the endpoint gives for one waybill: one row per step, each with its three-digit
 * state code, its wording as 已到达：<site> and its China wall clock, ordered by state with the
 * latest first. Every row must be the whole waybill asked. The site after the wording's colon is
 * the location; the row's phone numbers and the operator field, which holds stray dates and
 * places, are left out.
 */
export function parseRiyu(body: unknown, raw: string): CarrierResult {
  const number = normalizeRiyuNumber(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SchemaError(PROVIDER, 'Riyu returned an invalid reply');
  const { success, message, data } = body as Record<string, unknown>;
  if (success !== true) {
    if (/频繁|太快|过多/.test(text(message, 120))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Riyu did not complete the lookup');
  }
  const list = data && typeof data === 'object' ? (data as Record<string, unknown>).orderTrackList : undefined;
  if (!Array.isArray(list) || list.length > 500) throw new SchemaError(PROVIDER, 'Riyu returned an invalid route');
  if (!list.length) throw new NotFoundError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of list as unknown[]) {
    if (!row || typeof row !== 'object') throw new SchemaError(PROVIDER, 'Riyu returned an invalid route row');
    const { omsNo, state, desc, oprTime } = row as Record<string, unknown>;
    if (omsNo !== number) throw new SchemaError(PROVIDER, 'Riyu returned another waybill');
    if (typeof state !== 'string' || !/^\d{3}$/.test(state)) throw new SchemaError(PROVIDER, 'Riyu returned an invalid state');
    const clock = typeof oprTime === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(oprTime) : null;
    const date = clock && calendarDay(+clock[1]!, +clock[2]!, +clock[3]!);
    if (!clock || !date) throw new SchemaError(PROVIDER, 'Riyu returned an invalid scan time');
    const description = text(desc, 200).replace(/1[3-9]\d{9}/g, '').trim();
    if (!description) continue;
    const location = /[:：]\s*(.{1,40})$/.exec(description)?.[1]?.trim();
    const stage = riyuStage(state);
    const event: CarrierEvent = { local_time: `${date}T${clock[4]}`, description, provider_code: state,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // The rows keep the endpoint's order, by state: a step's clock is sometimes written after the delivery's.
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof riyuStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
