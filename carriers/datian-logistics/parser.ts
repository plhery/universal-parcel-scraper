import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { datianStage } from './status.js';

export const PROVIDER = 'DTW Logistics';
/** The tracking form the site's 运单查询 page frames. */
export const DATIAN_FORM = 'https://owtrack.dtw.com.cn/';
/** The page the form redirects a waybill to. */
export const DATIAN_PAGE = `${DATIAN_FORM}CustomerScanQuery2023.aspx`;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<tr>\s*<td>([^<]{1,40})<\/td>\s*<td>(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):([0-5]\d):([0-5]\d)<\/td>\s*<td>([^<]{0,80})<\/td>\s*<td>([^<]{0,80})<\/td>\s*<td>[^<]{0,80}<\/td>\s*<td class="TextLeft">[^<]{0,400}<\/td>\s*<\/tr>/g;

/** DTW and twelve digits, as Datian's waybills and the ones kuaidi.com lists are. */
export function normalizeDatianNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^DTW\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'DTW waybills are DTW and twelve digits');
  return number;
}

export function datianLookupUrl(number: string): string {
  return `${DATIAN_PAGE}?${new URLSearchParams({ w: number })}`;
}

/**
 * The tracker's page for one waybill: a summary table naming it, then its scans, newest first,
 * on China wall clocks. The summary must name the whole waybill asked. A row's step, such as
 * 货物进站, is its code and the station its location. The sender, the recipient's address, the
 * customer service agent, the signatory and the truck positions in the remarks are left out.
 */
export function parseDatian(html: string, raw: string): CarrierResult {
  const number = normalizeDatianNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'DTW returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'DTW answered with a browser check');
  if (!html.includes('<div class="tab_con">')) throw new SchemaError(PROVIDER, 'DTW returned a page without its tracking results');
  if (/<p class="kong">\s*查询不到数据\s*<\/p>/.test(html)) throw new NotFoundError(PROVIDER);
  const waybills = [...html.matchAll(/id="rWaybill_LinkButton1_\d+"[^>]*>([^<]{1,40})<\/a>/g)].map(match => match[1]!.trim().toUpperCase());
  if (waybills.length !== 1 || waybills[0] !== number) throw new SchemaError(PROVIDER, 'DTW returned another waybill');
  const start = html.indexOf('详细扫描列表');
  const table = start < 0 ? undefined : /<table[^>]*>([\s\S]*?)<\/table>/.exec(html.slice(start))?.[1];
  if (table === undefined) throw new SchemaError(PROVIDER, 'DTW returned a waybill without its scan table');
  const rows = [...table.matchAll(ROW)];
  if (rows.length > 1000 || rows.length !== (table.match(/<tr>/g)?.length ?? 0) - 1) throw new SchemaError(PROVIDER, 'DTW returned an invalid scan row');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, waybill, year, month, day, hour, minute, second, station, step] of rows) {
    if (waybill!.trim().toUpperCase() !== number) throw new SchemaError(PROVIDER, 'DTW returned a scan of another waybill');
    const date = calendarDay(+year!, +month!, +day!);
    if (!date || +hour! > 23) throw new SchemaError(PROVIDER, 'DTW returned an invalid scan time');
    const description = textFromHtml(step, 80), location = textFromHtml(station, 80);
    if (!description) continue;
    const stage = datianStage(description);
    const event: CarrierEvent = { local_time: `${date}T${hour!.padStart(2, '0')}:${minute}:${second}`, description, provider_code: description,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page lists rows newest first; rows on the same clock keep its order.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof datianStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.location ? `${newest.description} · ${newest.location}` : newest.description,
    last_update: null, last_update_local: newest.local_time, events: events.slice(0, 300) };
}
