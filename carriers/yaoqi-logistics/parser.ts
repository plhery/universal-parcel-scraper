import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { yaoqiStage } from './status.js';

export const PROVIDER = 'Yaoqi Logistics';
/** The site whose tracking box posts to the page below. */
export const YAOQI_SITE = 'http://www.yaoqi56.com/';
/** The site's EMMIS tracking page, which answers over HTTP only. */
export const YAOQI_TRACK = `${YAOQI_SITE}cgi-bin/GInfo.dll?EmmisTrack`;
/** The site's account on the EMMIS server, which the form sends beside the waybill. */
export const YAOQI_ACCOUNT = 'szyqi';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<tr align='center' bgcolor='#[0-9A-F]{6}'><td align='center' bgcolor='#[0-9A-F]{6}' class='trackList(?:Odd|Even)'>(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)<\/td><td align='left' bgcolor='#[0-9A-F]{6}' class='trackList(?:Odd|Even)'>([^<]{0,120})<\/td><td align='left' bgcolor='#[0-9A-F]{6}' class='trackList(?:Odd|Even)'>([^<]{0,400})<\/td><\/tr>/g;

/** The waybills on kuaidi.com's Yaoqi page are twelve digits. */
export function normalizeYaoqiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Yaoqi waybills are twelve digits');
  return number;
}

const clean = (html: string, max: number) => textFromHtml(html, max).replace(/[\s\u3000]+/g, ' ').trim();

/** A row's wording without the courier, the phone numbers or the question line. */
function wording(detail: string): string {
  return detail
    .replace(/\s*[，,]?\s*如有疑问[\s\S]*$/, '')
    .replace(/\s*的\s*【[^】]{0,20}】\s*[（(][^）)]{0,40}[）)]\s*(?=正在派件$)/, ' ')
    .replace(/\s+的(派件已签收)$/, ' $1')
    .replace(/[（(]?\d{7,}[）)]?/g, '')
    .replace(/[\s，,:：]+$/, '')
    .trim();
}

/** The scan a row's fixed phrase names. */
function code(description: string): string | undefined {
  if (/派件已签收$/.test(description)) return '已签收';
  if (/正在派件$/.test(description)) return '正在派件';
  if (/^快件 已从 .+ 发出$/.test(description)) return '已发出';
  if (/^快件 已到达 /.test(description)) return '已到达';
  return undefined;
}

/**
 * The tracking page for one waybill: a header naming it, then its scans, oldest first, on China
 * wall clocks to the minute. The header must name the whole waybill asked. A row's place is the
 * site that scanned it, followed in brackets by the site it came from or goes to, which is left
 * out. The courier's name and the phone numbers in the wording are removed.
 */
export function parseYaoqi(html: string, raw: string): CarrierResult {
  const number = normalizeYaoqiNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Yaoqi returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Yaoqi answered with a browser check');
  const head = /<td id='theTrackInfo'>([\s\S]{0,2000}?)<\/td>/.exec(html)?.[1];
  if (head === undefined) throw new SchemaError(PROVIDER, 'Yaoqi returned a page without its tracking results');
  if (/^<strong>\s*没有跟踪信息。?\s*<\/strong>$/.test(head.trim())) throw new NotFoundError(PROVIDER);
  const named = /<span id='HeaderNum'>运\s*单\s*号：\s*([^<]{1,40})<\/span>/.exec(head)?.[1]?.trim();
  if (named !== number) throw new SchemaError(PROVIDER, 'Yaoqi returned another waybill');
  const table = /<table[^>]*id='oTHtable'>([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (table === undefined) throw new NoHistoryError(PROVIDER);
  const rows = [...table.matchAll(ROW)];
  if (rows.length > 1000 || rows.length !== (table.match(/<tr\b/g)?.length ?? 0) - 1) throw new SchemaError(PROVIDER, 'Yaoqi returned an invalid scan row');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, clock, place, detail] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date) throw new SchemaError(PROVIDER, 'Yaoqi returned an invalid scan time');
    const description = wording(clean(detail!, 400));
    if (!description) continue;
    const location = clean(place!, 120).replace(/\s*\[[^\]]*\]$/, '').trim();
    const type = code(description), stage = type ? yaoqiStage(type) : undefined;
    const event: CarrierEvent = { local_time: `${date}T${clock}:00`, description, ...(type ? { provider_code: type } : {}),
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Oldest first on the page; newest first here, rows on the same minute in reverse page order.
  events.reverse().sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof yaoqiStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 300) };
}
