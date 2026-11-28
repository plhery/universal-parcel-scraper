import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { statusMap, tobkkStage } from './status.js';

export const PROVIDER = 'Thai Bear Logistics';
export const CARRIER = 'tobkk';
// The public example's page is about 12 kB.
export const TOBKK_MAX_BYTES = 512 * 1024;

// "THATXW10000000ABC": the line's waybill numbers mix letters and digits. The tracker takes up to
// ten at once separated by semicolons, so only one, in letters and digits, is sent.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// "2023-08-18 20:44:05": the scan's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const NOT_FOUND = '暂无此单号';
// The warehouse a scan names, or the one it arrived at or left.
const STATION = /(?:^|，|货物在|已从|抵达)【([^【】]{1,40})】/u;
// "货物在【曼谷仓SE】安排【FLASH快递】配送": the Thai courier the parcel was handed to.
const HANDOVER = /安排【([^【】]{1,40})】配送/u;
const PARTNERS: readonly (readonly [RegExp, string])[] = [
  [/^flash/i, 'flash-express'],
  [/^(?:泰国邮政|thailand ?post)/i, 'thailand-post'],
  [/^j&t/i, 'j-and-t'],
];
const MAX_SCANS = 200;

/** A Thai Bear waybill number, as its tracking form takes it. */
export function normalizeTobkkNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Thai Bear waybill numbers are eight to thirty letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Reads the tracking page for one number: the order under it, its delivery number with the Thai
 * courier, and its scans grouped under labels, each on the wall clock the page gives without a
 * zone. The page answers an unknown number with one sentence and keeps the number in its form.
 */
export function parseTobkk(html: string, raw: string): CarrierResult {
  const number = normalizeTobkkNumber(raw);
  const $ = load(html);
  const asked = normalizeTrackingNumber($('input[name="order_num"]').attr('value') ?? '');
  const orders = $('.order-item').toArray().map((item) => $(item));
  if (!orders.length) {
    if (!text($('body').text()).includes(NOT_FOUND)) return invalid('Thai Bear returned neither an order nor its not-found answer');
    if (asked !== number) throw new IndeterminateError(PROVIDER, 'Thai Bear answered about another number');
    throw new NotFoundError(PROVIDER, 'Thai Bear has no order under this number');
  }
  const order = orders.find((item) => normalizeTrackingNumber(item.find('.order-head .li_two').first().text()) === number);
  if (!order) throw new IndeterminateError(PROVIDER, 'Thai Bear answered about another order');
  const overall = text(order.find('.order-head span[style*="red"]').first().text()).slice(0, 40);
  const onward = normalizeTrackingNumber(order.find('.order_detail [data-clipboard-text]').first().attr('data-clipboard-text') ?? '');

  const scans: { index: number; event: CarrierEvent & { local_time: string } }[] = [];
  order.find('.wuliu_list .vo_list').each((_group, group) => {
    const label = text($(group).find('.vo_right > span.red').first().text()).slice(0, 40) || null;
    $(group).find('.vo_right > div').each((_row, row) => {
      const parts = $(row).children('div').toArray().map((cell) => text($(cell).text()));
      const clock = CLOCK.exec(parts[1] ?? '');
      const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
      if (!clock || !day) return invalid('Thai Bear returned a scan without a readable time');
      const description = (parts[0] ?? '').slice(0, 300);
      if (!description) return invalid('Thai Bear returned a scan without a wording');
      const location = STATION.exec(description)?.[1]?.trim();
      const staged = tobkkStage(label, description);
      scans.push({ index: scans.length, event: {
        local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6] ?? '00'}`, description,
        ...(label ? { provider_code: label } : {}), ...(location ? { location } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
      } });
      if (scans.length > MAX_SCANS) invalid('Thai Bear returned too many scans');
    });
  });
  if (!scans.length) return invalid('Thai Bear returned an order without scans');
  const seen = new Set<string>();
  const events = scans.filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  const courier = events.map((event) => HANDOVER.exec(event.description ?? '')?.[1]).find(Boolean);
  const partner = courier ? PARTNERS.find(([pattern]) => pattern.test(courier))?.[1] : undefined;
  const handoff = /^[A-Z0-9]{6,30}$/.test(onward) && onward !== number;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    ...(overall ? { provider_code: overall } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    ...(handoff ? { delivery_tracking_number: onward, ...(partner ? { delivery_carrier: partner } : {}) } : {}),
    events,
  };
}
