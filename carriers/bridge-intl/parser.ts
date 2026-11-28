import { load, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { bridgeStage, statusMap } from './status.js';

export const PROVIDER = 'Bridge Intl';
export const CARRIER = 'bridge-intl';
// The fragment is a couple of kilobytes for a handful of rows.
export const BRIDGE_MAX_BYTES = 256 * 1024;
// Letters and digits, with a digit: two letters, nine digits and two letters on the sample.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// The fragment's whole answer for a number it holds nothing under: "no record yet".
const NOT_FOUND = '暂无记录';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// A whole page, not the fragment the query page puts in place.
const WHOLE_PAGE = /<(?:html|head|body)\b/i;
// "订单号 AU111492026SG , 2021-03-08 , 订单已生成": the order line, with its day and its status.
const ORDER = /^订单号\s*([A-Za-z0-9-]{1,40})\s*[,，]\s*(\d{4}-\d{2}-\d{2})\s*[,，]\s*(\S.{0,99})$/u;
// "转运单号：9975674610015": the number the parcel goes on under in China.
const HANDOFF = /^转运单号\s*[:：]\s*([A-Za-z0-9]{8,30})$/u;
// Kuaidi100's codes for the courier the page's onward link names, with the catalog's id.
const COURIERS: ReadonlyMap<string, string> = new Map([['youzhengguonei', 'china-post'], ['ems', 'china-post']]);
const WEIGHT = /^\d{1,4}(?:\.\d{1,3})?$/;
const MAX_ROWS = 100;

/** A number on the firm's query page, without spaces or hyphens. */
export function normalizeBridgeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Bridge Intl numbers are 6 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the fragment. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A day as the page writes it, checked against the calendar. */
function day(value: string): string {
  const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd', { zone: 'UTC' });
  if (!parsed.isValid || parsed.year < 2000) return invalid('Bridge Intl returned an invalid day');
  return value;
}

/** A cell's text without the white text the page hides in it, such as a batch's code. */
function visible($: CheerioAPI, cell: Element): string {
  const copy = $(cell).clone();
  copy.find('span[style*="color:white"], span[style*="color: white"], .hiddentxt').remove();
  return clean(copy.text(), 300);
}

/** The table whose header row is these headings. */
function table($: CheerioAPI, headings: readonly string[]): Element[] | null {
  for (const element of $('table').toArray()) {
    const rows = $(element).find('tr').toArray();
    const head = rows[0] ? $(rows[0]).find('th').toArray().map((th) => clean($(th).text(), 20)) : [];
    if (head.join('|') === headings.join('|')) return rows.slice(1);
  }
  return null;
}

type Partner = Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number' | 'destination_country'>;

/**
 * The number a Chinese courier takes the parcel on under, when the page states it and its Kuaidi100 link names
 * it, and the courier by its catalog id when the link names one the catalog knows and that courier's own rules
 * take the number.
 */
function partnerOf($: CheerioAPI, number: string): Partner {
  const stated = $('b').toArray().map((b) => HANDOFF.exec(clean($(b).text(), 80).replace(/\s+/gu, ''))?.[1]).find(Boolean);
  const href = $('a[href*="kuaidi100.com/chaxun"]').first().attr('href');
  if (!stated || !href) return {};
  let link: URL;
  try {
    link = new URL(href);
  } catch {
    return {};
  }
  const onward = normalizeTrackingNumber(stated);
  if (onward === number || normalizeTrackingNumber(link.searchParams.get('nu') ?? '') !== onward) return {};
  const named = COURIERS.get((link.searchParams.get('com') ?? '').toLowerCase());
  const taken = named && (detectCarrierMatch(onward).candidates as string[]).includes(named);
  return { destination_country: 'CN', delivery_tracking_number: onward, ...(taken ? { delivery_carrier: named } : {}) };
}

/**
 * Bridge Intl's order for one number, from the fragment `getorder.php` gives its query page: the order line with
 * the number, its day and its status, a table with the number, the recipient's address, the weight and the day
 * it reached the warehouse, the rows dated to the day, oldest first, and the number a Chinese courier takes it
 * on under. Rows keep their day; the page gives no clock.
 *
 * The recipient's address is never read.
 */
export function parseBridge(body: string, raw: string): CarrierResult {
  const number = normalizeBridgeNumber(raw);
  const reply = body.replace(/^\uFEFF/, '').trim();
  if (reply === NOT_FOUND) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
  if (isChallenge(reply)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  if (WHOLE_PAGE.test(reply)) return invalid('Bridge Intl returned a page instead of its fragment');
  const $ = load(reply);
  const order = ORDER.exec(clean(load(reply.split(/<br\s*\/?>/i)[0]!).text(), 200));
  const parcel = table($, ['单号', '目的地', '重量', '入库日期']);
  if (!order || !parcel || parcel.length !== 1) return invalid('Bridge Intl returned a reply that is not its order');
  const cells = $(parcel[0]).find('td').toArray();
  if (cells.length !== 4) return invalid('Bridge Intl returned an invalid order');
  // The order line and the table both repeat the number.
  const named = [order[1]!, visible($, cells[0]!)].map((value) => normalizeTrackingNumber(value));
  if (named.some((value) => value !== number)) throw new IndeterminateError(PROVIDER, 'Bridge Intl answered for another order');

  const rows = table($, ['时间', '记录']) ?? [];
  if (rows.length > MAX_ROWS) return invalid('Bridge Intl returned too many rows');
  const scans = rows.map((row, index) => {
    const parts = $(row).find('td').toArray();
    if (parts.length !== 2) return invalid('Bridge Intl returned an invalid row');
    const description = visible($, parts[1]!);
    if (!description) return invalid('Bridge Intl returned a row without its text');
    const staged = bridgeStage(description);
    const event: CarrierEvent = { local_time: day(visible($, parts[0]!)), description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    return { index, event };
  });
  // Newest first; the page's order settles rows of one day.
  scans.sort((a, b) => (b.event.local_time as string).localeCompare(a.event.local_time as string) || b.index - a.index);
  const events = scans.map(({ event }) => event);

  const weight = visible($, cells[2]!);
  const facts = {
    ...(WEIGHT.test(weight) && Number(weight) > 0 ? { weight_kg: Number(weight) } : {}),
    ...(/从澳大利亚/u.test(reply) ? { origin_country: 'AU' } : {}),
  };
  const partner = partnerOf($, number);
  const newest = events[0];
  if (!newest) {
    // An order without rows stands on its order line's status, when the map knows it.
    const status = clean(order[3]!, 100);
    const staged = bridgeStage(status);
    if (!staged) throw new NoHistoryError(PROVIDER);
    return {
      status: languageStageStatus(staged.stage), current_stage: staged.stage, current_stage_source: staged.source,
      last_status_text: status, last_update: null, last_update_local: day(order[2]!), expected_delivery: null,
      ...facts, ...partner, summary_only: true, events: [],
    };
  }
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...facts,
    ...partner,
    events,
  };
}
