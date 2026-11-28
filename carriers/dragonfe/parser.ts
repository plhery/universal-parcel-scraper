import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { dragonfeStage, statusMap } from './status.js';

export const PROVIDER = 'DF Logistics';
export const CARRIER = 'dragonfe';
// The public example's page is under 2 kB.
export const DRAGONFE_MAX_BYTES = 256 * 1024;

// "JPNDFE230201060565": the line's code and the waybill's digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// "快件JPNDFE230201060565": the shipment the page answers about, above its boxes.
const SHIPMENT = /<div class="box-item"[^>]*>\s*快件\s*([^<]{1,40}?)\s*<\/div>/gu;
const ROW = /<tr>\s*<td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/g;
// "2023-02-08 16:01:00": the row's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const NOT_FOUND = '暂未查到包裹相关数据';
// The warehouse or city a row names in brackets.
const STATION = /【([^【】]{1,40})】/u;
const MAX_SCANS = 300;

/** A DF Logistics waybill number, as its tracker takes it. */
export function normalizeDragonfeNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'DF Logistics waybill numbers are eight to thirty letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * Reads the tracker's page for one number: the shipment it names, then a table per box of rows
 * oldest first, each a time on the wall clock the page gives without a zone and a Chinese wording.
 * An unknown number gets a table with one sentence instead of rows.
 */
export function parseDragonfe(html: string, raw: string): CarrierResult {
  const number = normalizeDragonfeNumber(raw);
  const named = [...html.matchAll(SHIPMENT)].map((match) => normalizeTrackingNumber(match[1]!));
  if (!named.length) return invalid('DF Logistics returned a page without the shipment it answers about');
  if (!named.every((value) => value === number)) throw new IndeterminateError(PROVIDER, 'DF Logistics answered about another number');
  const rows = [...html.matchAll(ROW)].map((match) => [textFromHtml(match[1], 40), textFromHtml(match[2], 400)] as const)
    .filter(([clock]) => clock !== '时间');
  if (!rows.length) {
    if (textFromHtml(html, 4000).includes(NOT_FOUND)) throw new NotFoundError(PROVIDER, 'DF Logistics has no shipment under this number');
    return invalid('DF Logistics returned neither rows nor its not-found answer');
  }
  if (rows.length > MAX_SCANS) invalid('DF Logistics returned too many rows');
  const seen = new Set<string>();
  const events = rows.map(([value, wording], index) => {
    const clock = CLOCK.exec(value);
    const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
    if (!clock || !day) return invalid('DF Logistics returned a row without a readable time');
    const description = wording.slice(0, 300);
    if (!description) return invalid('DF Logistics returned a row without a wording');
    const location = STATION.exec(description)?.[1]?.trim();
    const staged = dragonfeStage(description);
    const event: CarrierEvent & { local_time: string } = {
      local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6] ?? '00'}`, description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return { index, event };
  }).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);
  const latest = events[0]!;
  const staged = leadingScan(events, statusMap);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: null,
    last_update_local: latest.local_time,
    expected_delivery: null,
    destination_country: 'CN',
    events,
  };
}
