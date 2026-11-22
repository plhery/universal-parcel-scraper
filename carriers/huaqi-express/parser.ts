import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { huaqiStage } from './status.js';

export const PROVIDER = 'Huaqi Express';
/** The site's waybill tracking page, which renders the history for the numbers in its query. */
export const HUAQI_PAGE = 'https://www.huaqiex.com/tracking';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<li class="timline-item">\s*<div class="timeline\s*(?:active)?\s*"\s*><\/div>\s*<div class="order-content">\s*<span class="arrow"><\/span>\s*<span class="time">(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)<\/span>\s*<span class="desc">([^<]{0,600})<\/span>\s*<\/div>\s*<\/li>/g;

/** The waybill on kuaidi.com's Huaqi page is twelve digits. */
export function normalizeHuaqiNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Huaqi waybills are twelve digits');
  return number;
}

export function huaqiLookupUrl(number: string): string {
  return `${HUAQI_PAGE}?${new URLSearchParams({ orderNumbers: number })}`;
}

/** A row's wording without couriers, scanners, phone numbers or the closing courtesy lines. */
function wording(desc: string): string {
  return desc
    .replace(/\s+(?=【)/g, '').replace(/(?<=】)\s+/g, '')
    .replace(/[，,]?\s*如有疑问[^【]{0,20}【[^】]{0,60}】[\s\S]*$/, '')
    .replace(/交给【[^】]{0,60}】[，,]?/, '')
    .replace(/（[^）]{0,120}）/g, '')
    .replace(/[，,]?\s*扫描员是【[^】]{0,30}】/g, '')
    .replace(/[，,]该场地[^。！]{0,80}[。！]?$/, '')
    .replace(/1[3-9]\d{9}|\d{3,4}-\d{7,8}/g, '')
    .replace(/[\s，,。:：]+$/, '')
    .trim();
}

/** The scan a row's fixed phrase names, as 已收件 or 快件到达. */
function code(description: string): string | undefined {
  if (/^已收件/.test(description)) return '已收件';
  if (/^已入库/.test(description)) return '已入库';
  if (/^(?:快件)?离开【/.test(description)) return '离开';
  if (/^快件在【[^】]+】完成分拣/.test(description)) return '完成分拣';
  if (/^快件到达【/.test(description)) return '快件到达';
  if (/^(?:快件开始|车辆正在)长途运输/.test(description)) return '长途运输';
  if (/正在派送途中$/.test(description)) return '派送途中';
  if (/^您的快件已派送至本人/.test(description)) return '已派送';
  if (/^快件已签收$/.test(description)) return '已签收';
  return undefined;
}

const PLACED = new Set(['已收件', '已入库', '离开', '完成分拣', '快件到达']);

/**
 * The tracking page for one waybill: a panel titled with the waybill, holding its scans newest
 * first on China wall clocks. The panel must be the whole waybill asked; an empty panel is a
 * waybill the site does not know. Huaqi hands long-distance legs to a partner network, whose
 * hub scans appear in the same list.
 */
export function parseHuaqi(html: string, raw: string): CarrierResult {
  const number = normalizeHuaqiNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Huaqi returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Huaqi answered with a browser check');
  const titles = [...html.matchAll(/<h2 class="layui-colla-title">运单号：([^<]{1,40})<i/g)].map(match => match[1]!.trim());
  if (titles.length !== 1 || titles[0] !== number) throw new SchemaError(PROVIDER, 'Huaqi returned another waybill');
  const list = /<ul class="timeline-list">([\s\S]*?)<\/ul>/.exec(html)?.[1];
  if (list === undefined) throw new SchemaError(PROVIDER, 'Huaqi returned a waybill without its scan list');
  const rows = [...list.matchAll(ROW)];
  if (rows.length > 500 || rows.length !== (list.match(/<li\b/g)?.length ?? 0)) throw new SchemaError(PROVIDER, 'Huaqi returned an invalid scan row');
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, clock, desc] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date) throw new SchemaError(PROVIDER, 'Huaqi returned an invalid scan time');
    const description = wording(textFromHtml(desc!, 600));
    if (!description) continue;
    const type = code(description), stage = type ? huaqiStage(type) : undefined;
    const place = type && PLACED.has(type) ? /【([^】]{1,40})】/.exec(description)?.[1] : undefined;
    const event: CarrierEvent = { local_time: `${date}T${clock}`, description, ...(type ? { provider_code: type } : {}),
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // The page lists scans newest first; rows on the same clock keep its order.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof huaqiStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events: events.slice(0, 300) };
}
