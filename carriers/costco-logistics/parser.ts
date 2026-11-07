import { DateTime } from 'luxon';
import { isCostcoLogisticsReference } from '../../core/detection/costcoLogistics.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean, textFromHtml } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { costcoLogisticsStage } from './status.js';

export const PROVIDER = 'Costco Logistics';
export const COSTCO_MAX_BYTES = 1024 * 1024;
export const COSTCO_PAGE = 'https://logistics.costco.com/tracking';
export const COSTCO_API = 'https://logistics.costco.com/api/tracking/api/v2/tracking/';
const MAX_ROWS = 500;
const BLOCKED = /_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Human Verification)|verify (?:that )?you are human|requests? must (?:originate|come) from (?:a )?browser/i;

export function normalizeCostcoLogisticsNumber(raw: string): string {
  if (!isCostcoLogisticsReference(raw)) throw new InvalidInputError(PROVIDER, 'Costco Logistics requires its complete 1I tracking number');
  return normalizeTrackingNumber(raw);
}

export function costcoTrackingUrl(raw: string): string {
  return `${COSTCO_PAGE}?${new URLSearchParams({ id: normalizeCostcoLogisticsNumber(raw) })}`;
}

export function isCostcoBlockPage(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** The market's MM/DD/YY and twelve-hour clock, without an inferred zone. */
function wallClock(date: unknown, time: unknown): string {
  const day = typeof date === 'string' ? /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(date.trim()) : null;
  const clock = typeof time === 'string' ? /^([1-9]|1[0-2]):([0-5]\d)\s*([ap]m)$/i.exec(time.trim()) : null;
  if (!day || !clock) throw new SchemaError(PROVIDER, 'Costco Logistics returned an invalid scan clock');
  const hour = Number(clock[1]) % 12 + (clock[3]!.toLowerCase() === 'pm' ? 12 : 0);
  // This 1I series carries a 20xx order date. UTC checks the calendar only.
  const parsed = DateTime.fromObject({ year: 2000 + Number(day[3]), month: Number(day[1]), day: Number(day[2]),
    hour, minute: Number(clock[2]), second: 0 }, { zone: 'UTC' });
  if (!parsed.isValid) throw new SchemaError(PROVIDER, 'Costco Logistics returned an invalid scan date');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

function wording(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) throw new SchemaError(PROVIDER, 'Costco Logistics returned a scan without its wording');
  const description = textFromHtml(value, 1000)
    .replace(/\s+(?:signed (?:for )?by|received by|delivered to)\b.*$/i, '')
    .replace(/https?:\/\/\S+|\S+@\S+\.\S+|\+?\b\d[\d ().-]{7,}\d\b/gi, '').trim();
  if (!description) throw new SchemaError(PROVIDER, 'Costco Logistics returned a scan without its wording');
  return clean(description, 500);
}

/** Only the bound parcel's milestones; location strings can be recipient addresses. */
export function parseCostcoLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCostcoLogisticsNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.status)) throw new SchemaError(PROVIDER, 'Costco Logistics returned an invalid tracking envelope');
  const status = payload.status;
  if (status.statusCode === '98' && status.statusMessage === 'NODATAFOUND' && payload.serviceResponse === null && payload.errorDetails === null) throw new NotFoundError(PROVIDER);
  if (status.statusCode !== '00' || status.statusMessage !== 'SUCCESS') throw new IndeterminateError(PROVIDER, 'Costco Logistics did not complete the lookup');
  const shipment = payload.serviceResponse;
  if (!isRecord(shipment) || !Array.isArray(shipment.trackingNumbers) || !Array.isArray(shipment.trackingDetails)) throw new SchemaError(PROVIDER, 'Costco Logistics returned no shipment details');
  if (shipment.trackingNumbers.length !== 1 || shipment.trackingNumbers[0] !== number || shipment.trackingDetails.length !== 1) throw new IndeterminateError(PROVIDER, 'Costco Logistics did not identify one matching parcel');
  const detail: unknown = shipment.trackingDetails[0];
  if (!isRecord(detail) || detail.trackingNumber !== number) throw new IndeterminateError(PROVIDER, 'Costco Logistics answered for another parcel');
  if (!Array.isArray(detail.orderDetailList) || detail.orderDetailList.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Costco Logistics returned invalid history groups');
  const scans: { event: CarrierEvent; index: number }[] = [];
  for (const group of detail.orderDetailList) {
    if (!isRecord(group) || !Array.isArray(group.orderList)) throw new SchemaError(PROVIDER, 'Costco Logistics returned an invalid history group');
    if (scans.length + group.orderList.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Costco Logistics returned too many scans');
    for (const row of group.orderList) {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Costco Logistics returned an invalid scan');
      // Current wording distinguishes arrival from departure on the delivery round;
      // legacy status repeats "Received at MDO" for both.
      const description = wording(row.resultStatus), local_time = wallClock(group.date, row.time);
      const stage = costcoLogisticsStage(description);
      scans.push({ index: scans.length, event: { local_time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } });
    }
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  scans.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || left.index - right.index);
  const seen = new Set<string>();
  const events = scans.map(scan => scan.event).filter(event => {
    const key = JSON.stringify([event.local_time, event.description]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = events[0]!, stage = costcoLogisticsStage(latest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!, last_update: null, last_update_local: latest.local_time!, expected_delivery: null, events };
}

export function parseCostcoLogisticsBody(body: string, number: string): CarrierResult {
  if (isCostcoBlockPage(body)) throw new ChallengeError(PROVIDER, 'Costco Logistics returned browser verification');
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Costco Logistics returned unreadable tracking JSON'); }
  return parseCostcoLogistics(payload, number);
}
