import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { lindaoStage } from './status.js';

export const PROVIDER = 'Lindao Express';
/** The site's 货物追踪 page, whose form posts the numbers typed in back to it. */
export const LINDAO_PAGE = 'http://www.ldxpress.com/home/goods/index.html';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const ROW = /<p>(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d) ([^<]{1,300})<\/p>/g;

/** Lindao's order numbers and the Japanese waybills it pairs them with are twelve digits. */
export function normalizeLindaoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '') : '';
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Lindao numbers are twelve digits');
  return number;
}

/** The step a row names, without the place some of them carry, and that place. */
function step(text: string): { code: string; location?: string } {
  const centre = /^抵达(.{1,20}操作中心)$/.exec(text);
  if (centre) return { code: '抵达操作中心', location: centre[1] };
  const airport = /^(.{1,20}空港)(から出発|に到着予定)$/.exec(text);
  if (airport) return { code: `空港${airport[2]}`, location: airport[1] };
  return { code: text.split('；')[0]!.trim() };
}

/**
 * The tracking page for one number: Lindao's order number, the Japanese waybill its last leg
 * travels under, then the scans newest first on the wall clocks of China and, once the parcel
 * lands, Japan. One of the two numbers must be the whole number asked; a page saying the order
 * does not exist is a number Lindao does not know.
 */
export function parseLindao(html: string, raw: string): CarrierResult {
  const number = normalizeLindaoNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Lindao returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Lindao answered with a browser check');
  if (/<h3>\s*该订单不存在\s*<\/h3>/.test(html)) throw new NotFoundError(PROVIDER);
  const start = html.indexOf('<div class="ncon_hw03">');
  const block = start < 0 ? undefined : html.slice(start, html.indexOf('</div>', start));
  if (!block) throw new SchemaError(PROVIDER, 'Lindao returned a page without its tracking results');
  const orders = [...block.matchAll(/<p>订单号\d+：<span class="hong">([^<]{0,40})<\/span><\/p>/g)].map(match => match[1]!.trim());
  const waybills = [...block.matchAll(/<p>运单号\d+：<span class="hong">([^<]{0,40})<\/span><\/p>/g)].map(match => match[1]!.trim());
  if (orders.length !== 1 || waybills.length !== 1 || ![orders[0], waybills[0]].includes(number)) {
    throw new SchemaError(PROVIDER, 'Lindao returned another order');
  }
  const rows = [...block.matchAll(ROW)];
  if (rows.length > 300 || rows.length !== (block.match(/<p>/g)?.length ?? 0) - 3) throw new SchemaError(PROVIDER, 'Lindao returned an invalid scan row');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, clock, text] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date) throw new SchemaError(PROVIDER, 'Lindao returned an invalid scan time');
    const description = textFromHtml(text!, 300);
    if (!description) continue;
    const { code, location } = step(description), stage = lindaoStage(code);
    const event: CarrierEvent = { local_time: `${date}T${clock}`, description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NotFoundError(PROVIDER);
  // Rows keep the page's order, newest first: China and Japan clocks an hour apart do not sort as instants.
  const newest = events.find(event => event.stage === 'delivered') ?? events[0]!;
  const stage = newest.stage as ReturnType<typeof lindaoStage>;
  const delivery = waybills[0] !== number && /^\d{8,20}$/.test(waybills[0]!) ? waybills[0] : undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    ...(delivery ? { delivery_tracking_number: delivery } : {}), events: events.slice(0, 200) };
}
