import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, zonedTime } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/index.js';
import { countryName } from '../../places/trackingLocation.js';
import { goodStage, statusMap } from './status.js';
import { trackingInfoClock, trackingInfoRows, type TrackingInfoSite } from './trackingInfo.js';

export const PROVIDER = 'good-express-us';
// A page is about thirty kilobytes, most of it the form's state; a long history adds a few.
export const GOOD_MAX_BYTES = 512 * 1024;
/** The tracker dates every row on China's clock, the rows in the United States too. */
export const GOOD_ZONE = 'Asia/Shanghai';

// GD, eleven digits and US.
const NUMBER = /^GD\d{11}US$/;
// GOOD's site on the TrackingInfo platform. 无跟踪信息 is the only row of a number the tracker does not know,
// stamped with the moment of the lookup.
const SITE: TrackingInfoSite = { provider: PROVIDER, name: 'GOOD Express', notFound: '无跟踪信息', maxRows: 300 };
// "【美国US】" or "【中国CHN】": the country the row happened in, in Chinese with a Latin code.
const PLACE = /^【(\p{Script=Han}{1,12})[A-Z]{2,3}】\s*/u;
// "快递公司Dispatching delivery：顺丰速运,单号：587056104998": the domestic courier and its number.
const HANDOFF = /^快递公司Dispatching delivery：\s*([^,，]{1,40}?)\s*[,，]\s*单号：\s*([A-Za-z0-9]{4,40})$/i;
// The couriers GOOD has been seen handing parcels to in China, by the name its row gives them.
const COURIERS: Readonly<Record<string, string>> = { 顺丰速运: 'sf-express' };

/** A GOOD Express waybill: GD, eleven digits and US. */
export function normalizeGoodNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GOOD Express waybills are GD, eleven digits and US');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

const CHINESE_REGIONS = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
let countriesByName: Map<string, string> | undefined;
/** The country a row's Chinese name means, as an ISO code. */
function countryOf(name: string): string | undefined {
  if (!countriesByName) {
    countriesByName = new Map();
    for (const first of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const second of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const code = first + second;
        const label = CHINESE_REGIONS.of(code);
        if (label && label !== code && countryCode(code) === code) countriesByName.set(label, code);
      }
    }
  }
  return countriesByName.get(name);
}

/** A row's instant: its clock read on China time, which keeps one offset all year. */
function timeOf(value: string): string {
  const clock = trackingInfoClock(value);
  const parsed = clock ? zonedTime(clock, "yyyy-MM-dd'T'HH:mm:ss", GOOD_ZONE) : null;
  if (!parsed) return invalid('GOOD Express returned a row with an invalid time');
  return parsed.iso;
}

/** A row's wording, with the country it opens with moved to its location. */
function scanOf(cell: string): Pick<CarrierEvent, 'description' | 'location' | 'original_description'> & { description: string } {
  const text = textFromHtml(cell, 400);
  const place = PLACE.exec(text);
  const code = place ? countryOf(place[1]!) : undefined;
  if (!place || !code) return { description: text };
  const description = text.slice(place[0].length).trim();
  return description ? { description, location: countryName(code, 'en'), original_description: text } : { description: text };
}

/** The domestic courier and number of the newest hand-off row, when the row names them. */
function handoffOf(events: readonly CarrierEvent[]): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  for (const event of events) {
    const match = HANDOFF.exec(event.description ?? '');
    if (!match) continue;
    const number = normalizeTrackingNumber(match[2]!);
    const courier = COURIERS[match[1]!];
    // The number is SF's only when SF's own rules offer it.
    const named = courier !== undefined && (detectCarrierMatch(number).candidates as string[]).includes(courier);
    return { ...(named ? { delivery_carrier: courier } : {}), delivery_tracking_number: number };
  }
  return {};
}

/**
 * Reads GOOD Express's TrackingInfo page for one waybill: the number it echoes and its
 * rows, newest first. GOOD's own rows are Chinese with English in 【】, and open with
 * the country they happened in; once a courier in China takes the parcel, its rows
 * follow in Chinese. A number the tracker does not know gets one row, "无跟踪信息".
 */
export function parseGood(html: string, number: string): CarrierResult {
  const rows = trackingInfoRows(html, number, SITE);
  const seen = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const { clock, cell } of rows) {
    const scan = scanOf(cell);
    if (!scan.description) return invalid('GOOD Express returned a row without its wording');
    const time = timeOf(clock);
    const key = JSON.stringify([time, scan.description, scan.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = goodStage(scan.description);
    events.push({ time, ...scan, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  // The tracker's order stands: newest first.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time!,
    expected_delivery: null,
    ...handoffOf(events),
    events,
  };
}
