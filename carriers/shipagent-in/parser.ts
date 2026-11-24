import { carrierIdFromName } from '../../core/catalog/hints.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { shipAgentStage } from './status.js';

export const PROVIDER = 'shipagent-in';
// A shipment with its rows is a few kilobytes.
export const SHIPAGENT_MAX_BYTES = 256 * 1024;

// The tracker takes ShipAgent's own reference or the courier's AWB, in letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "2026-08-13T09:52:55.000Z": the scan's wall clock, which the service labels UTC.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?Z$/;
// ShipGlobal India's AWB, which carries ShipAgent's international parcels.
const SHIPGLOBAL_AWB = /^SG3\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{7}$/;
// The service stamps a courier's bare status with the time of the read.
const READ_CLOCK_MS = 60_000;
const MAX_ROWS = 300;

/** A number for ShipAgent's tracker: its own reference or the courier's AWB. */
export function normalizeShipAgentNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the AWB or ShipAgent tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max = 300): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) return invalid('ShipAgent returned an invalid field');
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed && trimmed !== '-' ? trimmed : undefined;
};

function wallClock(value: unknown): string {
  const parts = typeof value === 'string' ? CLOCK.exec(value) : null;
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001) return invalid('ShipAgent returned an invalid scan time');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/** A row's or a status's stage: the wording ShipAgent gives it, else its own code for it, else the shared rules. */
function stageOf(code: string | undefined, wording: string): { stage: Stage; stage_source: string } | undefined {
  const mapped = shipAgentStage(code ?? null, wording);
  if (mapped) return { stage: mapped, stage_source: 'carrier_map' };
  const worded = classifyWording(wording, 'pending');
  return worded.source === 'none' ? undefined : { stage: worded.stage, stage_source: worded.source };
}

/**
 * Reads the reply for one number. The order's reference, the towns it goes from and to and
 * the weight stay behind. The rows keep their wall clock: the service labels it UTC, but
 * it is the clock of the place each row names.
 */
export function parseShipAgent(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) return invalid('ShipAgent returned an unreadable reply');
  const { shipment, timeline, updatedAt } = payload.data;
  if (!isRecord(shipment) || !Array.isArray(timeline) || timeline.length > MAX_ROWS) return invalid('ShipAgent returned an invalid shipment');
  const awb = text(shipment.awbNumber, 64), master = text(shipment.masterTrackingNumber, 64);
  if (![awb, master].some((value) => value && normalizeTrackingNumber(value) === number)) {
    throw new IndeterminateError(PROVIDER, 'ShipAgent answered for another shipment');
  }
  const readAt = typeof updatedAt === 'string' ? Date.parse(updatedAt) : Number.NaN;
  const lastScan = typeof shipment.lastScan === 'string' ? shipment.lastScan : undefined;

  const events = timeline.flatMap((row, index): { index: number; event: CarrierEvent & { local_time: string } }[] => {
    if (!isRecord(row)) return invalid('ShipAgent returned an invalid row');
    const description = text(row.message) ?? invalid('ShipAgent returned a row without its wording');
    const code = text(row.status, 40);
    if (code && !/^[a-z_]{2,40}$/.test(code)) return invalid('ShipAgent returned an invalid row status');
    const local = wallClock(row.timestamp);
    // A courier's bare status comes as one row stamped with the read itself, which is no scan.
    if (row.timestamp === lastScan && Math.abs(Date.parse(String(row.timestamp)) - readAt) < READ_CLOCK_MS) return [];
    const location = text(row.location, 120);
    const keptCode = code && code !== 'unknown' ? code : undefined;
    const event: CarrierEvent & { local_time: string } = { local_time: local, description,
      ...(keptCode ? { provider_code: keptCode } : {}), ...(location ? { location } : {}), ...stageOf(keptCode, description) };
    return [{ index, event }];
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index).map(({ event }) => event);

  const code = text(shipment.status, 40);
  const label = text(shipment.statusLabel, 120);
  const current = code && code !== 'unknown' ? stageOf(code, label ?? '') : undefined;
  if (!current && events.length === 0) return invalid('ShipAgent returned a shipment without a status or rows');
  const stage = current?.stage ?? events.find((event) => event.stage)?.stage as Stage | undefined;
  const service = text(shipment.serviceSla, 120);
  const destination = countryCode(shipment.destCountry);
  // ShipGlobal India carries the international parcels under its own AWB; a courier within
  // India, which the service names, has its full history under the same AWB.
  const courier = awb && (/^shipglobal/i.test(text(shipment.courierCode, 60) ?? '')
    ? (SHIPGLOBAL_AWB.test(awb) ? 'shipglobal-in' : undefined) : carrierIdFromName(text(shipment.courierName, 60) ?? ''));
  const partner = awb && courier && courier !== PROVIDER
    ? { delivery_carrier: courier, ...(awb !== number ? { delivery_tracking_number: awb } : {}) } : {};
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current ? current.stage_source : events.find((event) => event.stage)!.stage_source! } : {}),
    ...(code && code !== 'unknown' ? { provider_code: code } : {}),
    // A status the service codes unknown is labelled "Status unavailable"; the newest row says more.
    last_status_text: (current ? label : undefined) ?? events[0]?.description ?? label ?? null,
    last_update: null,
    ...(events[0] ? { last_update_local: events[0].local_time } : {}),
    expected_delivery: null,
    ...(shipment.estimatedDelivery !== null && shipment.estimatedDelivery !== undefined ? { unread_estimates: ['data.shipment.estimatedDelivery'] } : {}),
    ...(service ? { service_name: service } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...partner,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
