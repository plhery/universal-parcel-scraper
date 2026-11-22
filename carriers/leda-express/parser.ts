import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { ledaStage, statusMap } from './status.js';

export const PROVIDER = 'Leda Express';
/** The site's tracking page, whose form posts the number typed in back to it. The site answers over HTTP only. */
export const LEDA_PAGE = 'http://www.leda-express.com/queryexpress.html';
export const LEDA_MAX_BYTES = 1_000_000;
const MAX_ROWS = 300;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|g-recaptcha|h-captcha|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// LD and fourteen digits.
const NUMBER = /^LD\d{14}$/;
// "2026-10-13 13:00 ": the row's wall clock, to the minute.
const ROW = /<tr><td>(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d) ?<\/td><td>([^<]{0,600})<\/td><\/tr>/g;
// Leda's own rows open with the place in 【】, "【中国香港】"; SF Express's with its city in [], "[深圳市]".
const LEDA_PLACE = /^【(?:中国)?(\p{Script=Han}{2,12})】\s*/u;
const SF_PLACE = /^\[(\p{Script=Han}{2,12})\]\s*/u;
// "顺丰 SF…": the courier in China and its waybill.
const HANDOFF = /^(\p{Script=Han}{1,10})\s+([A-Z0-9]{4,40})$/u;
// The couriers Leda has been seen handing parcels to in China, by the name its page gives them.
const COURIERS: Readonly<Record<string, string>> = { 顺丰: 'sf-express' };

/** A Leda waybill: LD and fourteen digits. */
export function normalizeLedaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Leda Express waybills are LD and fourteen digits');
  return number;
}

/** A row's wording, with the place it opens with moved to its location. */
function scanOf(cell: string): Pick<CarrierEvent, 'description' | 'location' | 'original_description'> & { description: string } {
  const text = textFromHtml(cell, 600);
  const place = LEDA_PLACE.exec(text) ?? SF_PLACE.exec(text);
  const description = place ? text.slice(place[0].length).trim() : '';
  return place && description ? { description, location: place[1]!, original_description: text } : { description: text };
}

/** The courier in China and the number the parcel travels under with it, when the page names them. */
function handoffOf(cell: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const match = HANDOFF.exec(textFromHtml(cell, 80));
  if (!match) return {};
  const number = match[2]!, courier = COURIERS[match[1]!];
  // The number is the courier's only when that courier's rules offer it.
  const named = courier !== undefined && (detectCarrierMatch(number).candidates as readonly string[]).includes(courier);
  return { ...(named ? { delivery_carrier: courier } : {}), delivery_tracking_number: number };
}

/**
 * The tracking page for one waybill: Leda's number and the waybill of the courier it hands the
 * parcel to in China, then the rows oldest first on China's clock, Leda's own from Hong Kong to
 * customs in Shenzhen, then the courier's, copied word for word. A page saying the waybill is
 * not found, naming the whole number asked, is a number Leda does not know.
 */
export function parseLeda(html: string, raw: string): CarrierResult {
  const number = normalizeLedaNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Leda Express returned an empty page');
  if (html.length > LEDA_MAX_BYTES) throw new SchemaError(PROVIDER, 'Leda Express returned an oversized page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Leda Express answered with a browser check');
  const start = html.indexOf('<div id="ship200apiResponse"');
  const end = start < 0 ? -1 : html.indexOf('<div id="ship200_trackingtool_container"', start);
  if (end < 0) throw new SchemaError(PROVIDER, 'Leda Express returned a page without its tracking results');
  const block = html.slice(start, end);
  const missing = /<p class="apiError">\s*错误:\s*Tracking#:\s*([^<]{0,64}?)\s*-\s*Not Found\s*<\/p>/.exec(block);
  if (missing) {
    if (missing[1]!.toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Leda Express answered for another number');
    throw new NotFoundError(PROVIDER, 'Leda Express has no waybill under this number');
  }
  const header = /<td[^>]*>货单号：<b>([^<]{0,64})<\/b><\/td>\s*<td>国内快递单号：<b>([^<]{0,120})<\/b><\/td>/.exec(block);
  if (!header) throw new SchemaError(PROVIDER, 'Leda Express returned a page without its waybill');
  if (header[1]!.trim().toUpperCase() !== number) throw new SchemaError(PROVIDER, 'Leda Express returned another waybill');
  const handoff = handoffOf(header[2]!);
  const rows = [...block.matchAll(ROW)];
  // Every row after the header must be read, or the page has changed.
  if (rows.length > MAX_ROWS || rows.length !== (block.match(/<tr\b/g)?.length ?? 0) - 1) {
    throw new SchemaError(PROVIDER, 'Leda Express returned an unreadable row');
  }
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const [, year, month, day, clock, cell] of rows) {
    const date = calendarDay(+year!, +month!, +day!);
    if (!date) throw new SchemaError(PROVIDER, 'Leda Express returned an invalid row time');
    const scan = scanOf(cell!);
    if (!scan.description) throw new SchemaError(PROVIDER, 'Leda Express returned a row without its wording');
    const staged = ledaStage(scan.description);
    const event: CarrierEvent = { local_time: `${date}T${clock}:00`, ...scan, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) {
    throw new NoHistoryError(PROVIDER, 'Leda Express lists the waybill without a row', { reason: 'listed',
      deliveryCarrier: handoff.delivery_carrier, deliveryTrackingNumber: handoff.delivery_tracking_number });
  }
  events.reverse();
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!, last_update: null, last_update_local: events[0]!.local_time!, expected_delivery: null,
    ...handoff, events };
}
