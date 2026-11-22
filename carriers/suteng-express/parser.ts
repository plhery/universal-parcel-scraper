import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { sutengStage } from './status.js';

export const PROVIDER = 'Suteng Express';
/** The site whose waybill box opens the tracker. */
export const SUTENG_SITE = 'https://www.ste56.com/';
/** The tracker the site's box opens; it answers on this address only, over HTTP. */
export const SUTENG_ENDPOINT = 'http://106.55.23.231:8082/SearchScanInfoInterface/searchCode.do';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;

/** The waybills on Suteng's pages and the ones kuaidi.com lists are twelve digits. */
export function normalizeSutengNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Suteng waybills are twelve digits');
  return number;
}

export function sutengLookupUrl(number: string): string {
  return `${SUTENG_ENDPOINT}?${new URLSearchParams({ billcode: number })}`;
}

/** A row's wording without the courier, their phone number or the signatory. Branch names stay. */
function wording(cell: string): string {
  return textFromHtml(cell, 400)
    .replace(/\s*([【】，,])\s*/g, '$1')
    .replace(/的【[^】]{0,40}】(?=已收件|正在派件)/g, '')
    .replace(/签收人是【[^】]{0,40}】/g, '')
    .replace(/\s*(?:联系)?电话\s*[:：]?\s*\[[^\]]{0,120}\]/g, '')
    .replace(/\d{7,}/g, '')
    .trim();
}

/** The scan a row stands for, from the fixed phrase its wording is built around. */
const CODES: readonly (readonly [string, RegExp])[] = [
  ['已收件', /已收件$/],
  ['快件到达', /^快件到达/],
  ['装车', /装车[,，]正发往/],
  ['二次分拣', /已二次分拣/],
  ['正在派件', /正在派件$/],
  ['签收', /^派件已【签收】/],
];

function code(text: string): string | undefined {
  return CODES.find(([, pattern]) => pattern.test(text))?.[0];
}

/** The branch a row names after its city, or for a signature, the signing branch. */
function location(text: string): string | undefined {
  return (/签收网点是【[^】]{1,20}】【([^】]{1,40})】/.exec(text) ?? /【[^】]{1,20}】【([^】]{1,40})】/.exec(text)
    ?? /^【[^】]{1,20}】([^【】，,\s]{2,40}?)已/.exec(text) ?? /【([^】]{1,40})】/.exec(text))?.[1];
}

/**
 * The tracker's page for one waybill: a header row with the waybill, its branches and its
 * signature, then the scans, oldest first, on China wall clocks. The header must be the whole
 * waybill asked. Rows of the master waybill's other pieces are left out.
 */
export function parseSuteng(html: string, raw: string): CarrierResult {
  const number = normalizeSutengNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Suteng returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Suteng answered with a browser check');
  const header = /运单信息<\/div>\s*<table[^>]*>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (!header) throw new SchemaError(PROVIDER, 'Suteng returned a page without its waybill table');
  if (/<td colspan='9'[^>]*>\s*未查到订单信息/.test(header)) throw new NotFoundError(PROVIDER);
  const waybills = [...header.matchAll(/<tr><td>([^<]{1,40})<\/td>/g)].map(match => match[1]!.trim());
  if (waybills.length !== 1 || waybills[0] !== number) throw new SchemaError(PROVIDER, 'Suteng returned another waybill');
  const trace = new RegExp(`跟踪信息【主单:${number}】</div>\\s*<table[^>]*>([\\s\\S]*?)</table>`).exec(html)?.[1];
  if (trace === undefined) throw new NoHistoryError(PROVIDER);
  const rows = [...trace.matchAll(/<tr><td>(\d{1,40})<\/td><td>(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)<\/td><td[^>]*>([\s\S]*?)<\/td><td>[\s\S]*?<\/td><\/tr>/g)];
  if (rows.length > 500 || rows.length !== (trace.match(/<tr>/g)?.length ?? 0)) throw new SchemaError(PROVIDER, 'Suteng returned an invalid history row');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, waybill, year, month, day, time, cell] of rows) {
    if (waybill !== number) continue;
    const date = calendarDay(+year!, +month!, +day!);
    const description = wording(cell!);
    if (!date) throw new SchemaError(PROVIDER, 'Suteng returned an invalid scan time');
    if (!description) continue;
    const type = code(description), stage = type ? sutengStage(type) : undefined, place = location(description);
    const event: CarrierEvent = { local_time: `${date}T${time}`, description, ...(type ? { provider_code: type } : {}),
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows on the same clock keep the tracker's order reversed.
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof sutengStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
