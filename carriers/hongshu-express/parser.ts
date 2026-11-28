import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { huaxiaRow } from '../huaxia-express/parser.js';
import { hongshuStage, statusMap } from './status.js';

export const PROVIDER = 'HongShu Express';
export const CARRIER = 'hongshu-express';
// One waybill's page is some 25 kilobytes.
export const HONGSHU_MAX_BYTES = 512 * 1024;
// H and seven digits, as the public sample.
const NUMBER = /^H\d{7}$/;
const HOME = 'America/Toronto';
const CHINA = 'Asia/Shanghai';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|_____tmd_____|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
// The tracker's own answer for a number it holds nothing under.
const UNKNOWN = '货单不存在';
const HEADING = '货单查询结果';
// "2024-08-01 11:02 (星期四)": the day, the minute and the weekday.
const CLOCK = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s*[(（]星期[一二三四五六日天][)）])?$/u;
// The domestic courier's rows, copied with their city in square brackets first: "[西安市]…".
const DOMESTIC = /^\[(\p{Script=Han}{1,10}[市县区州盟])\]\s*/u;
// HongShu's milestones, entered by hand with the country or leg in 【】 first: 【加拿大】, 【中国】, 【飞行中】.
const MILESTONE = /^【([^】]{1,8})】/u;
const MAX_ROWS = 500;

/** A HongShu waybill: H and seven digits, without spaces or hyphens. */
export function normalizeHongshuNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HongShu Express waybills are H and seven digits');
  return number;
}

interface Row { readonly local: string; readonly zone: string | null; readonly basis: 'place' | 'carrier' | null; readonly location?: string; readonly description: string }

/**
 * A row's wording, place and clock. The domestic courier's rows name their Chinese city and are
 * on China's clock; they lose the courier's name and phone, where the parcel was left and the
 * notes after them. A milestone on Canada is on Toronto's clock and one on China on China's; a
 * milestone dated at midnight was entered without its time and keeps its day alone. HongShu's
 * other rows are its Mississauga store's, on Toronto's clock.
 */
function row(day: string, minute: string, text: string): Row {
  const domestic = DOMESTIC.exec(text);
  if (domestic) {
    return { local: `${day}T${minute}`, zone: CHINA, basis: 'place', location: domestic[1]!,
      description: huaxiaRow(text.slice(domestic[0].length)).description };
  }
  const milestone = MILESTONE.exec(text);
  if (milestone) {
    const local = minute === '00:00' ? day : `${day}T${minute}`;
    const zone = milestone[1] === '加拿大' ? HOME : milestone[1] === '中国' ? CHINA : null;
    return { local, zone: local === day ? null : zone, basis: zone && local !== day ? 'place' : null, description: text };
  }
  return { local: `${day}T${minute}`, zone: HOME, basis: 'carrier', description: text };
}

/** A row's clock, checked against the calendar. */
function wallClock(value: string): { day: string; minute: string } {
  const match = CLOCK.exec(value);
  const parsed = match ? DateTime.fromISO(`${match[1]}T${match[2]}`, { zone: 'UTC' }) : null;
  if (!match || !parsed?.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm") !== `${match[1]}T${match[2]}`) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan time`);
  }
  return { day: match[1]!, minute: match[2]! };
}

/**
 * The page HongShu's tracker renders for one waybill: a heading, then a bar
 * with the waybill, the recipient and the domestic courier, then a table of
 * rows, oldest first. The waybill must be the whole number asked. The
 * recipient is never read. A row dated after the lookup is left out.
 */
export function parseHongshu(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeHongshuNumber(raw);
  if (!html.includes(HEADING)) {
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page that is not its tracking result`);
  }
  const $ = load(html);
  const bars = $('.titlebar');
  if (!bars.length && $('body').text().includes(UNKNOWN)) throw new NotFoundError(PROVIDER, `${PROVIDER} has no parcel under this number`);
  if (bars.length !== 1) throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without one waybill`);
  const bar = bars.first();
  const field = (label: string) => {
    const items = bar.find('.titleitem').filter((_, item) => clean($(item).find('.titlename').text(), 40) === label);
    return items.length === 1 ? clean(items.find('.titlecontent').text(), 120) : null;
  };
  if (normalizeTrackingNumber(field('货单号:') ?? '') !== number) throw new SchemaError(PROVIDER, `${PROVIDER} did not answer for the parcel asked`);
  const cells = bar.next('table').find('tbody > tr');
  if (cells.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an oversized history`);
  const events: CarrierEvent[] = [];
  cells.each((_, element) => {
    const columns = $(element).children('td');
    if (columns.length !== 2) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid scan`);
    const { day, minute } = wallClock(clean(columns.eq(0).text(), 80));
    const text = clean(columns.eq(1).text(), 1000);
    if (!text) return;
    const read = row(day, minute, text);
    const description = clean(read.description, 300);
    if (!description) return;
    const instant = firstOccurrence(DateTime.fromISO(read.local, { zone: read.zone ?? HOME }));
    if (instant.toMillis() > readAt + CLOCK_SKEW_MS) return;
    const staged = hongshuStage(description);
    events.push({
      ...(read.zone && read.basis ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: read.zone, time_zone_basis: read.basis } : {}),
      local_time: read.local,
      ...(read.location ? { location: read.location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first: the page lists the rows oldest first.
  events.reverse();
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  // The domestic courier is named; its number is shown only to whoever gives the recipient's phone.
  const courier = field('国内快递单号:') ?? '';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead?.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(/^顺丰/u.test(courier) ? { delivery_carrier: 'sf-express' } : {}),
    events,
  };
}
