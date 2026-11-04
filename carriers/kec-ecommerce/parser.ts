import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { kecStage } from './status.js';

export const CARRIER = 'kec-ecommerce';
export const PROVIDER = 'KEC eCommerce';
export const KEC_MAX_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 300;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const OFFSET = /^UTC([+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

/** Explicit-carrier lookups accept uploaded shipper numbers; this is no detection rule. */
export function normalizeKecNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'KEC eCommerce needs one tracking number');
  return number;
}

function text(value: unknown, maximum: number, required = false): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > maximum * 4) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid scan field');
  const answer = clean(value, maximum);
  if (required && !answer) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an unnamed scan');
  return answer;
}

function scanOf(value: unknown): { event: CarrierEvent; timestamp: number } {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid scan');
  const wall = typeof value.event_date === 'string' ? value.event_date : '';
  const offset = typeof value.timezone === 'string' ? OFFSET.exec(value.timezone)?.[1] : undefined;
  if (!WALL_CLOCK.test(wall) || !offset) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid stated scan clock');
  const time = `${wall.replace(' ', 'T')}${offset}`;
  const at = explicitOffsetTime(time);
  if (!at) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid scan calendar');
  // event_date is the wall clock in timezone; timezone_date is its UTC twin.
  // Keeping the former preserves the offset the carrier states.
  if (value.timezone_date != null && value.timezone_date !== '') {
    const utc = typeof value.timezone_date === 'string' && WALL_CLOCK.test(value.timezone_date)
      ? explicitOffsetTime(`${value.timezone_date.replace(' ', 'T')}Z`) : null;
    if (!utc || utc.timestamp !== at.timestamp) throw new SchemaError(PROVIDER, 'KEC eCommerce returned conflicting scan clocks');
  }
  const code = text(value.status_code, 80, true);
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(code)) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid scan code');
  const description = text(value.track_message, 500, true), location = text(value.location, 160);
  const staged = kecStage(code, description);
  return { timestamp: at.timestamp, event: { time, description, provider_code: code,
    ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } };
}

/** The official guest feed: a whole matching shipment and scans with stated offsets. */
export function parseKec(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKecNumber(raw);
  if (!isRecord(payload) || (typeof payload.responsecode !== 'string' && typeof payload.responsecode !== 'number')) {
    throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid tracking envelope');
  }
  if (payload.responsecode !== '200001' && payload.responsecode !== 200001) throw new IndeterminateError(PROVIDER, 'KEC eCommerce did not complete the tracking lookup');
  if (!Array.isArray(payload.data)) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid shipment list');
  if (!payload.data.length) throw new NoHistoryError(PROVIDER);
  if (payload.data.length !== 1) throw new IndeterminateError(PROVIDER, 'KEC eCommerce returned several shipments for one request');
  const shipment: unknown = payload.data[0];
  if (!isRecord(shipment) || typeof shipment.tracking_number !== 'string' || shipment.tracking_number.length > 64) {
    throw new SchemaError(PROVIDER, 'KEC eCommerce returned no whole tracking number');
  }
  if (shipment.tracking_number.trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'KEC eCommerce answered for another number');
  if (!Array.isArray(shipment.status) || shipment.status.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'KEC eCommerce returned an invalid history');
  if (!shipment.status.length) throw new NoHistoryError(PROVIDER);
  const scans = shipment.status.map(scanOf).map((scan, index) => ({ ...scan, index }));
  scans.sort((a, b) => b.timestamp - a.timestamp || a.index - b.index);
  const events = scans.map(scan => scan.event), newest = events[0]!, current = newest;
  const stage = current.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.stage_source! } : {}),
    last_status_text: newest.description!, last_update: newest.time!, expected_delivery: null,
    events: events.slice(0, MAX_EVENTS), ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}) };
}
