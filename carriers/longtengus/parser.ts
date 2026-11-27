import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { CLOCK_SKEW_MS } from '../../core/result/due.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { trackingInfoClock, trackingInfoRows, type TrackingInfoSite } from '../good-express-us/trackingInfo.js';
import { longtengStage, statusMap } from './status.js';

export const PROVIDER = 'Longteng';
export const CARRIER = 'longtengus';
// A page is about twelve kilobytes, most of it the form's state; a long history adds a few.
export const LONGTENG_MAX_BYTES = 512 * 1024;
/** The tracker's server clock, which stamps every row: US Pacific time, where the firm is. */
export const LONGTENG_ZONE = 'America/Los_Angeles';

// S, then the day the waybill was created and five digits, the one layout seen.
const NUMBER = /^S\d{13}$/;
// Longteng's site on the TrackingInfo platform. 暂无查询结果 is the only row of a number the tracker does not
// know, stamped with the moment of the lookup.
const SITE: TrackingInfoSite = { provider: PROVIDER, name: 'Longteng', notFound: '暂无查询结果', maxRows: 300 };
// "清关完毕，正在派送，单号：…": the number of the courier in China that delivers the parcel.
const HANDOFF = /单号\s*[：:]\s*([A-Za-z0-9]{8,30})\s*$/;
// Couriers in China a row may name, as Chinese names them.
const COURIERS: readonly (readonly [RegExp, string])[] = [
  [/顺丰/, 'sf-express'], [/中通/, 'zto'], [/圆通/, 'yto'], [/申通/, 'sto'], [/韵达/, 'yunda'], [/京东/, 'jd-logistics'],
  [/极兔/, 'j-and-t-cn'], [/德邦/, 'deppon'], [/邮政|EMS/i, 'china-post'],
];

/** A Longteng waybill: S and thirteen digits. */
export function normalizeLongtengNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Longteng waybills are S and thirteen digits');
  return number;
}

/**
 * The courier in China and its number, from the newest row that gives a number, when that row names one
 * courier and the courier's own rules offer the number. A number alone names no one.
 */
function handoffOf(events: readonly CarrierEvent[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const event of events) {
    const match = HANDOFF.exec(event.description ?? '');
    if (!match) continue;
    const number = normalizeTrackingNumber(match[1]!);
    const named = COURIERS.filter(([name]) => name.test(event.description!)).map(([, carrier]) => carrier);
    if (named.length !== 1 || !(detectCarrierMatch(number).candidates as string[]).includes(named[0]!)) return {};
    return { delivery_carrier: named[0]!, delivery_tracking_number: number };
  }
  return {};
}

/**
 * Reads Longteng's TrackingInfo page for one waybill: the number it echoes and its rows, oldest first, each a
 * wall clock without a zone and Chinese wording that names its place, if any, inside the text. The server
 * stamps every row on its own clock, US Pacific time, the rows in China too: each keeps its wall clock and is
 * dated on that zone. A clock that would date a row after the lookup leaves it its wall clock alone.
 */
export function parseLongteng(html: string, raw: string, readAt = Date.now()): CarrierResult {
  const number = normalizeLongtengNumber(raw);
  const rows = trackingInfoRows(html, number, SITE);
  const seen = new Set<string>();
  const read = rows.flatMap(({ clock, cell }, index) => {
    const local = trackingInfoClock(clock);
    if (!local) throw new SchemaError(PROVIDER, 'Longteng returned a row with an invalid time');
    const description = textFromHtml(cell, 400);
    if (!description) throw new SchemaError(PROVIDER, 'Longteng returned a row without its wording');
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) return [];
    seen.add(key);
    const instant = firstOccurrence(DateTime.fromISO(local, { zone: LONGTENG_ZONE }));
    const staged = longtengStage(description);
    const event: CarrierEvent = {
      ...(instant.toMillis() <= readAt + CLOCK_SKEW_MS
        ? { time: instant.toISO({ suppressMilliseconds: true })!, time_zone: LONGTENG_ZONE, time_zone_basis: 'carrier' } : {}),
      local_time: local,
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    return [{ index, event }];
  });
  // Oldest first on the page; the result runs newest first, rows of one second in the reverse of their order.
  const events = read.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || right.index - left.index)
    .map((entry) => entry.event);
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
    ...handoffOf(events),
    events,
  };
}
