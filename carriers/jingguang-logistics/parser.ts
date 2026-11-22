import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { jingguangStage } from './status.js';

export const PROVIDER = 'Jingguang Logistics';
export const JINGGUANG_ORIGIN = 'https://www.jgwl.cn';
/** The site's waybill search, whose script asks the endpoint below. */
export const JINGGUANG_PAGE = `${JINGGUANG_ORIGIN}/service/querybill`;
export const JINGGUANG_ENDPOINT = `${JINGGUANG_ORIGIN}/wx/websiteorderticket.aspx`;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** The waybills on Jingguang's pages and the ones kuaidi.com lists are eight digits. */
export function normalizeJingguangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Jingguang waybills are eight digits');
  return number;
}

/** The endpoint's JSON, or the failure a page in its place stands for. */
export function jingguangJson(text: string): unknown {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch {
    if (CHALLENGE.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Jingguang answered with a browser check');
    throw new SchemaError(PROVIDER, 'Jingguang returned an invalid reply');
  }
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? textFromHtml(value, max) : '');

/** A row's wording without the branch phone numbers it ends with or the signatory. */
function wording(description: string): string {
  return description
    .replace(/\s*[,，]?\s*如有疑问[\s\S]*$/, '')
    .replace(/^已签收【[^】]{0,40}】$/, '已签收')
    .replace(/(?:电话|手机)\s*[:：]?\s*[\d\-—或、/\s]{7,}/g, '')
    .replace(/\d{7,}/g, '')
    .replace(/[\s,，:：]+$/, '')
    .trim();
}

/** The scan a row stands for, as 已到达 or 已签收. */
function code(description: string): string | undefined {
  return /已[一-鿿]{2}/.exec(description.replace(/【[^】]*】/g, ''))?.[0];
}

/**
 * The scans the endpoint gives for one waybill, one row per scan with its branch, wall clock
 * and wording. Every row must be the whole waybill asked. A signature row's branch column holds
 * the signatory, and a delivery row's the branch's phone numbers; neither is kept, and the
 * branch the wording brackets is the location.
 */
export function parseJingguang(body: unknown, raw: string): CarrierResult {
  const number = normalizeJingguangNumber(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SchemaError(PROVIDER, 'Jingguang returned an invalid reply');
  const { success, message, data } = body as Record<string, unknown>;
  if (success !== true) {
    const reason = text(message, 120);
    // The page's own check: the code and its encrypted copy, which this adapter makes as the page does.
    if (/Key|验证码/i.test(reason)) throw new ChallengeError(PROVIDER, 'Jingguang refused the search page\'s check');
    if (/频繁|太快|过多/.test(reason)) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Jingguang did not complete the lookup');
  }
  if (!Array.isArray(data) || data.length > 500) throw new SchemaError(PROVIDER, 'Jingguang returned an invalid history');
  if (!data.length) throw new NotFoundError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of data as unknown[]) {
    if (!row || typeof row !== 'object') throw new SchemaError(PROVIDER, 'Jingguang returned an invalid history row');
    const { waybillcode, ticketTime, ticketDesc } = row as Record<string, unknown>;
    if (waybillcode !== number) throw new SchemaError(PROVIDER, 'Jingguang returned another waybill');
    const clock = typeof ticketTime === 'string' ? /^(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(ticketTime) : null;
    const date = clock && calendarDay(+clock[1]!, +clock[2]!, +clock[3]!);
    if (!clock || !date) throw new SchemaError(PROVIDER, 'Jingguang returned an invalid scan time');
    const description = wording(text(ticketDesc, 400));
    if (!description) continue;
    const type = code(description), stage = type ? jingguangStage(type) : undefined;
    const place = /【([^】]{1,40})】/.exec(description)?.[1];
    const event: CarrierEvent = { local_time: `${date}T${clock[4]}`, description, ...(type ? { provider_code: type } : {}),
      ...(place && type !== '已签收' ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // The rows come in scan order, not always by clock; newest first, equal clocks in reverse order.
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof jingguangStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
