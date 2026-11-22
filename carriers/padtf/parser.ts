import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { padtfStage } from './status.js';

export const PROVIDER = 'PAD Express';
export const PADTF_ORIGIN = 'https://www.padtf.com';
export const PADTF_PAGE = `${PADTF_ORIGIN}/express-tracking.html`;
export const PADTF_CAPTCHA = `${PADTF_ORIGIN}/captcha.php`;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|安全验证|访问受限|访问被拒绝)/i;

/** The waybills on PAD's pages and the ones kuaidi.com lists are twelve digits. */
export function normalizePadtfNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'PAD Express waybills are twelve digits');
  return number;
}

/** True for the page the tracker answers a wrong or missing captcha with. */
export function padtfRefusedCaptcha(html: string): boolean {
  return /id="douMsg"[\s\S]{0,200}验证码错误或者为空/.test(html);
}

/**
 * A row's wording without the phone numbers, the courier's name and the signatory it carries.
 * The branch names it brackets stay.
 */
function wording(row: string): string {
  return textFromHtml(row.replace(/<\/?b>/g, ''), 400)
    .replace(/\s*[,，:：]?\s*(?:联系|站点|派送员|客服|网点)?电话\s*\[[^\]]{0,120}\]/g, '')
    .replace(/站的\s*【[^】]{0,40}】/g, '站')
    .replace(/验收人\s*【[^】]{0,40}】\s*[,，]?\s*/g, '')
    // The collecting branch's name repeats after its bracket where its phone number stood.
    .replace(/【([^】]{1,40})】\s+\1$/, '【$1】')
    .replace(/\s*([【】，,])\s*/g, '$1')
    .replace(/[\s,，:：]+$/, '')
    .trim();
}

/** The phrase a row opens with, such as 已揽件 or 快件到达, which stands for its scan type. */
function code(text: string): string {
  return /^[^【，,:：\s\d]{2,12}/.exec(text)?.[0] ?? '';
}

function location(text: string): string | undefined {
  return (/派送站点【([^】]{1,40})】/.exec(text) ?? /【([^】]{1,40})】/.exec(text))?.[1];
}

export function parsePadtf(html: string, raw: string): CarrierResult {
  const number = normalizePadtfNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'PAD Express returned an empty page');
  if (padtfRefusedCaptcha(html)) throw new ChallengeError(PROVIDER, 'PAD Express refused the captcha answer');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'PAD Express answered with a browser check');
  const start = html.indexOf('class="datainfo"');
  if (start < 0) throw new SchemaError(PROVIDER, 'PAD Express returned a page without its tracking results');
  const end = html.indexOf('id="footer"', start);
  const results = html.slice(start, end > start ? end : start + 200_000);
  const lists = [...results.matchAll(/<div class="kj_list[^"]*">\s*<p class="kj_tit">单号<span>\s*([^<\s]{1,40})\s*<\/span>([\s\S]*?)<\/div>/g)];
  const list = lists.filter(match => match[1] === number);
  if (lists.length > 10 || list.length !== 1) throw new SchemaError(PROVIDER, 'PAD Express returned another waybill');
  const body = list[0]![2]!;
  const rows = [...body.matchAll(/<li>\s*(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)\s*-([\s\S]*?)<\/li>/g)];
  if (!rows.length) {
    if (/暂无物流记录/.test(body)) {
      // A waybill with its header row but no scans has been entered without being collected yet.
      if (/<table class="table_kj">/.test(results) && results.includes(`>${number} </div>`)) throw new NoHistoryError(PROVIDER);
      throw new NotFoundError(PROVIDER);
    }
    throw new SchemaError(PROVIDER, 'PAD Express returned a waybill without its history');
  }
  if (rows.length > 500 || (body.match(/<li>/g)?.length ?? 0) !== rows.length) throw new SchemaError(PROVIDER, 'PAD Express returned an invalid history row');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, time, row] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    const description = wording(row!);
    if (!date || !description) throw new SchemaError(PROVIDER, 'PAD Express returned an invalid history row');
    const type = code(description), stage = type ? padtfStage(type) : undefined, place = location(description);
    const event: CarrierEvent = { local_time: `${date}T${time}`, description, ...(type ? { provider_code: type } : {}),
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // The page lists rows oldest first.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof padtfStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 200) };
}
