import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { flowlinkText } from '../jdxexpress/flowlink.js';
import { statusMap, zgtuxStage } from './status.js';

export const PROVIDER = 'Tuxing Supply Chain';
export const CARRIER = 'zgtux';
// A waybill's page is a few kilobytes.
export const ZGTUX_MAX_BYTES = 512 * 1024;
// The firm's waybills are letters and digits; its box takes twelve characters.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
const ZONE = 'Asia/Shanghai';
// "2026-10-08 09:18": China's wall clock, to the minute.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const ECHO = /^运单号[:：]\s*([A-Za-z0-9 -]{1,64})$/u;
const NOT_FOUND = '查无相关路由信息';
const BUSY = /请求过于频繁/u;
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*Just a moment|acw_sc__v2|aliyun_waf|waf\.tencent|<title>\s*(?:滑动验证|验证码|安全验证|访问受限|访问被拒绝)/i;
const MAX_ROWS = 300;

/** A waybill number on the firm's tracker, without spaces or hyphens. */
export function normalizeZgtuxNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Tuxing Supply Chain waybills are 6 to 30 letters and digits');
  return number;
}

/** Whether a page is a browser check a CDN or a cloud firewall put in place of the tracker. */
export function isChallenge(body: string): boolean {
  return CHALLENGE.test(body.slice(0, 64_000));
}

/**
 * A row's text without the couriers, phones and hotlines the relayed JD Logistics and Deppon rows name, and
 * without the courtesy sentences after the first.
 */
export function zgtuxText(raw: string): string {
  return flowlinkText(raw).replace(/。.*$/u, '');
}

function wallClock(value: string): string {
  const match = CLOCK.exec(value.trim());
  const local = match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00` : '';
  const parsed = DateTime.fromISO(local, { zone: 'UTC' });
  if (!match || !parsed.isValid || parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid row time`);
  }
  return local;
}

/**
 * The firm's history for one waybill, newest first, from the `routes` page: the heading `运单号：<number>` over a
 * timeline whose items are each a wall clock on China's clock, to the minute, and a text. The single line
 * 查无相关路由信息 under the number asked is the tracker's only answer for a waybill it does not know; a page
 * without the heading says the server is busy or has changed. A clock that would date a row after the lookup
 * leaves it its wall clock alone.
 */
export function parseZgtux(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeZgtuxNumber(raw);
  if (isChallenge(html)) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a browser check`);
  const $ = load(html);
  const headings = $('h3').filter((_, element) => ECHO.test(clean($(element).text(), 100)));
  if (headings.length !== 1) {
    if (!headings.length && BUSY.test($('body').text())) throw new RateLimitedError(PROVIDER, undefined, `${PROVIDER} is rate limiting tracking requests`);
    throw new SchemaError(PROVIDER, `${PROVIDER} returned a page without its waybill`);
  }
  const echoed = ECHO.exec(clean(headings.first().text(), 100))![1]!;
  if (normalizeTrackingNumber(echoed) !== number) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const timeline = headings.first().nextAll('ul.layui-timeline').first();
  const items = timeline.children('li');
  if (!timeline.length || items.length > MAX_ROWS) throw new SchemaError(PROVIDER, `${PROVIDER} returned an invalid history`);
  if (items.length === 1 && !items.first().hasClass('layui-timeline-item') && clean(items.first().text(), 100) === NOT_FOUND) {
    throw new NotFoundError(PROVIDER, `${PROVIDER} has no route for this waybill`);
  }
  if (!items.length) throw new SchemaError(PROVIDER, `${PROVIDER} returned a waybill without rows`);
  const seen = new Set<string>();
  const read: CarrierEvent[] = [];
  for (const item of items.toArray()) {
    const row = $(item);
    const title = row.find('h3.layui-timeline-title');
    const text = row.find('p');
    if (!row.hasClass('layui-timeline-item') || title.length !== 1 || text.length !== 1) {
      throw new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable row`);
    }
    const local = wallClock(title.text());
    const description = zgtuxText(text.text());
    if (!description) continue;
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: ZONE }));
    const staged = zgtuxStage(description);
    read.push({
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local, description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    });
  }
  if (!read.length) throw new NoHistoryError(PROVIDER);
  // The page lists the rows newest first.
  const events = read;
  const latest = events[0]!;
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time ?? null,
    last_update_local: latest.local_time!,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    events,
  };
}
