import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isZtoTrackingNumber } from '../../core/detection/zto.js';
import { ztoFreightWaybill } from '../../core/detection/ztoFreight.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { relayedZtoText } from '../zto/relayed.js';
import { globalexpStage, statusMap } from './status.js';

export const PROVIDER = 'Global Express';
export const CARRIER = 'globalexp';
// The page is about 12 kilobytes with a score of rows.
export const GLOBALEXP_MAX_BYTES = 512 * 1024;
// Letters and digits, with a digit, as the page's search box takes them.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// The site's notice for a number it holds no order under, which does not repeat the number.
const NOT_FOUND = /<title>\s*温馨提示\s*<\/title>[\s\S]*<h1>\s*未查询到对应订单，请确认您输入的单号无误。?\s*<\/h1>/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
// Hong Kong's clock, which mainland China's matches: both keep UTC+8 all year.
const ZONE = 'Asia/Hong_Kong';
const MAX_ROWS = 200;
// The row that hands the parcel to ZTO in China, with ZTO's number: "转国内中通快递，单号：…".
const HANDOFF = /转国内(中通快运|中通快递|中通)[，,]?\s*单号\s*[:：]\s*([A-Z0-9]{8,30})/u;
// Where the firm's own row is: "【中国香港地区 - 香港】…", "到达：【中国 - 广州】…", "【广州口岸】…".
const OWN_PLACE = /^(?:到达[:：]\s*)?【([^【】]{1,40})】/u;
// A branch's first scan: "中国香港新界九龙湾分部 已揽收".
const COLLECTED_AT = /^(\S{2,30}) 已揽收$/u;

/** An order number on the firm's tracker, without spaces or hyphens. */
export function normalizeGlobalexpNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Global Express order numbers are 8 to 30 letters and digits');
  return number;
}

/** Whether a reply is a browser check a CDN or a cloud firewall put in place of the page. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/** A reply that is not the tracking page: a browser check, or a changed page. */
function notTrackingPage(body: string): never {
  if (isChallenge(body)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking page`);
}

/** A row's wall clock, to the second, checked against the calendar. */
function wallClock(value: string): string {
  const match = CLOCK.exec(clean(value, 40));
  const local = match ? `${match[1]}T${match[2]}` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

interface Row {
  readonly local: string;
  readonly raw: string;
}

function rowsOf($: CheerioAPI, number: string, body: string): Row[] {
  // The site's notice in place of the page: no order under the number, or another message.
  if ($('.system-message').length) {
    if (NOT_FOUND.test(body)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no order under this number`);
    if (isChallenge(body)) notTrackingPage(body);
    throw new IndeterminateError(PROVIDER, `${PROVIDER} answered with a notice instead of the order`);
  }
  // The page writes the number it answered for only into its search box.
  const echoed = $('input#orderid').attr('value');
  const result = $('#result');
  if (typeof echoed !== 'string' || result.length !== 1) notTrackingPage(body);
  if (normalizeTrackingNumber(echoed.slice(0, 64)) !== number) throw new IndeterminateError(PROVIDER, `${PROVIDER} answered for another number`);
  const table = result.find('table.am-table');
  if (!table.length) {
    // The number's page with nothing under it lists no rows; anything else there is a changed page.
    if (clean(result.text(), 200)) throw new SchemaError(PROVIDER, `${PROVIDER} returned an order page it does not lay out as before`);
    throw new NoHistoryError(PROVIDER);
  }
  const header = table.find('thead th').map((_, node) => clean($(node).text(), 20)).get();
  if (header.join('|') !== '日期|快件状态') throw new SchemaError(PROVIDER, `${PROVIDER} tracking columns changed`);
  const rows = table.find('tbody > tr').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  return rows.map((row) => {
    const cells = $(row).children('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row`);
    return { local: wallClock(cells.eq(0).text()), raw: cells.eq(1).text() };
  });
}

/** ZTO, or ZTO Freight, and its number, as the newest hand-off row names them, with that row's place in the list. */
function handoffOf(rows: readonly Row[]): { index: number; partner: Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> } | null {
  for (const [index, row] of rows.entries()) {
    const found = HANDOFF.exec(clean(row.raw, 2000));
    if (!found) continue;
    const number = normalizeTrackingNumber(found[2]!);
    if (found[1] === '中通快运') {
      const waybill = ztoFreightWaybill(number);
      return { index, partner: waybill ? { delivery_carrier: 'zto-freight', delivery_tracking_number: waybill } : {} };
    }
    return { index, partner: isZtoTrackingNumber(number) ? { delivery_carrier: 'zto', delivery_tracking_number: number } : {} };
  }
  return null;
}

/** The place the firm's own row names: the town after a region, "香港" in "中国香港地区 - 香港", else the bracket or the branch. */
function ownPlace(text: string): string {
  const bracket = clean(OWN_PLACE.exec(text)?.[1], 40);
  if (bracket) return clean(bracket.split(/\s+-\s+/u).at(-1), 40);
  return clean(COLLECTED_AT.exec(text)?.[1], 30);
}

/**
 * Global Express's history for one order, newest first: the page of
 * `/search_kuai_di/search/orderid/<number>`, which echoes the number in its search box and lists
 * the rows under it, newest first, each a wall clock without its zone. The firm writes its rows in
 * Hong Kong and at the Guangzhou border; once it hands the parcel to ZTO, it copies ZTO's rows above
 * its own, with ZTO's couriers, phones and pickup points, which are left out. Every row is dated on
 * Hong Kong's clock, which mainland China's matches.
 */
export function parseGlobalexp(body: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeGlobalexpNumber(raw);
  const rows = rowsOf(load(body), number, body);
  const handoff = handoffOf(rows);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const [index, row] of rows.entries()) {
    const { description, city } = relayedZtoText(row.raw);
    if (!description) continue;
    const relayed = handoff !== null && index < handoff.index;
    const location = relayed ? city : ownPlace(description);
    const key = JSON.stringify([row.local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(row.local, { zone: ZONE }));
    const staged = globalexpStage(description);
    events.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: row.local,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(handoff ? { destination_country: 'CN' } : {}),
    ...handoff?.partner,
    events,
  };
}
