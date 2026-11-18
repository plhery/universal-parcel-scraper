import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime, firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { rozetkaStage } from './status.js';

export const PROVIDER = 'ROZETKA Delivery';
export const ROZETKA_MAX_BYTES = 1_000_000;
const MAX_GROUPS = 100;
const MAX_SCANS = 2_000;
const MAX_EVENTS = 100;
// Overview and timeline clocks for the same update can differ by a few seconds.
const SAME_SCAN_MS = 60_000;
const LOCAL_CLOCK = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;
const OFFSET_CLOCK = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

/** The two whole identifier families the public tracker currently answers. */
export function rozetkaRequestNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^\d{12}$/.test(number)) return number;
  if (/^RMP\d{9}$/.test(number)) return `RMP-${number.slice(3)}`;
  throw new InvalidInputError(PROVIDER, 'ROZETKA Delivery requires a twelve-digit waybill or an RMP number');
}

function invalid(message = 'ROZETKA Delivery returned an invalid tracking response'): never {
  throw new SchemaError(PROVIDER, message);
}

/** The whole identity is compared before any field can be shortened. */
function identity(value: unknown, requested: string): void {
  if (typeof value !== 'string' || value.length > 128) invalid('ROZETKA Delivery returned a shipment without its number');
  if (normalizeTrackingNumber(value) !== normalizeTrackingNumber(requested)) {
    throw new IndeterminateError(PROVIDER, 'ROZETKA Delivery answered for another shipment');
  }
}

function wording(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000) invalid('ROZETKA Delivery returned an invalid status');
  return clean(value, 500);
}

function codeOf(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 999_999) invalid('ROZETKA Delivery returned an invalid status code');
  return String(value);
}

interface Clock {
  fields: Pick<CarrierEvent, 'time' | 'local_time'>;
  order: number;
}

/** Offset-less backend dates stay wall clocks. An explicitly supplied offset is kept. */
function clockOf(value: unknown): Clock {
  if (typeof value !== 'string') invalid('ROZETKA Delivery returned an invalid scan time');
  if (OFFSET_CLOCK.test(value)) {
    const parsed = explicitOffsetTime(value);
    if (parsed) return { fields: { time: parsed.iso }, order: parsed.timestamp };
  }
  if (LOCAL_CLOCK.test(value)) {
    const local = value.replace(' ', 'T');
    const checked = DateTime.fromISO(local, { zone: 'UTC' });
    if (checked.isValid && checked.toFormat("yyyy-MM-dd'T'HH:mm:ss") === local) {
      // The home network's zone orders a mixed response; it is not stamped on
      // an event the upstream itself left without an offset.
      const order = firstOccurrence(DateTime.fromISO(local, { zone: 'Europe/Kyiv' })).toMillis();
      return { fields: { local_time: local }, order };
    }
  }
  return invalid('ROZETKA Delivery returned an invalid scan time');
}

interface Scan {
  event: CarrierEvent;
  order: number;
}

function scanOf(value: unknown): Scan {
  if (!isRecord(value)) invalid('ROZETKA Delivery returned an invalid scan');
  const code = codeOf(value.id);
  const description = wording(value.name);
  const clock = clockOf(value.date);
  const stage = rozetkaStage(code);
  let location = '';
  if (value.location !== null && value.location !== undefined) {
    if (!isRecord(value.location)) invalid('ROZETKA Delivery returned an invalid scan location');
    const name = value.location.name;
    if (name !== null && name !== undefined && typeof name !== 'string') invalid('ROZETKA Delivery returned an invalid scan location');
    location = clean(name, 200);
  }
  return { order: clock.order, event: { ...clock.fields, provider_code: code, description,
    ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
}

function envelope(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.statusCode !== 'number') invalid('ROZETKA Delivery returned an invalid envelope');
  if (payload.statusCode !== 0) throw new IndeterminateError(PROVIDER, 'ROZETKA Delivery did not complete the lookup');
  return payload;
}

export interface RozetkaSummary {
  number: string;
  current: Scan;
  estimate?: string;
  pickup?: string;
}

/** The public overview must name the complete requested waybill and an actual dated state. */
export function parseRozetkaSummary(payload: unknown, raw: string): RozetkaSummary {
  const number = rozetkaRequestNumber(raw);
  const data = envelope(payload).data;
  if (!isRecord(data)) throw new IndeterminateError(PROVIDER, 'ROZETKA Delivery returned no shipment overview');
  identity(data.id, number);
  const current = scanOf({ id: data.last_status, name: data.last_status_name, date: data.last_status_date });
  let estimate: string | undefined;
  if (data.delivery_date !== null && data.delivery_date !== undefined && data.delivery_date !== '') {
    const clock = clockOf(data.delivery_date);
    estimate = clock.fields.time ?? clock.fields.local_time;
  }
  let pickup: string | undefined;
  if (isRecord(data.final_department)) {
    const name = data.final_department.public_name ?? data.final_department.name;
    if (typeof name === 'string') pickup = clean(name, 300) || undefined;
  }
  return { number, current, ...(estimate ? { estimate } : {}), ...(pickup ? { pickup } : {}) };
}

/**
 * The complete oldest-first history the public page asks after its overview.
 * The page adds future rail groups itself and keeps planning_route separate;
 * only dated statuses of reached groups become scans here.
 */
export function parseRozetkaHistory(payload: unknown, summary: RozetkaSummary): CarrierResult {
  const data = envelope(payload).data;
  if (!Array.isArray(data)) invalid('ROZETKA Delivery returned an invalid history');
  if (!data.length) throw new IndeterminateError(PROVIDER, 'ROZETKA Delivery returned no shipment history');
  if (data.length !== 1 || !isRecord(data[0])) invalid('ROZETKA Delivery returned an ambiguous history');
  const history = data[0];
  identity(history.track_id, summary.number);
  if (!Array.isArray(history.status_groups) || history.status_groups.length > MAX_GROUPS) invalid('ROZETKA Delivery returned invalid status groups');
  const scans: Scan[] = [];
  for (const group of history.status_groups) {
    if (!isRecord(group) || !Array.isArray(group.statuses)) invalid('ROZETKA Delivery returned an invalid status group');
    if (group.future !== undefined && typeof group.future !== 'boolean') invalid('ROZETKA Delivery returned an invalid reached marker');
    if (group.future === true) continue;
    if (scans.length + group.statuses.length > MAX_SCANS) invalid('ROZETKA Delivery returned an oversized history');
    scans.push(...group.statuses.map(scanOf));
  }
  // The backend supplies reached scans oldest first. Choose the second occurrence of
  // a repeated hour when the first would place a scan before its predecessor.
  for (let index = 1; index < scans.length; index++) {
    const scan = scans[index]!, previous = scans[index - 1]!.order;
    if (scan.order < previous && scan.event.local_time) {
      const candidates = DateTime.fromISO(scan.event.local_time, { zone: 'Europe/Kyiv' }).getPossibleOffsets();
      const later = candidates.find(clock => clock.toMillis() >= previous);
      if (later) scan.order = later.toMillis();
    }
  }
  // Stable ties reverse the official oldest-first order, keeping the last
  // reached scan first when several movements share a clock.
  const sorted = scans.map((scan, index) => ({ ...scan, index }))
    .sort((left, right) => right.order - left.order || right.index - left.index);
  const seen = new Set<string>();
  const unique = sorted.filter(scan => {
    const key = JSON.stringify(scan.event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let current = summary.current;
  if (history.last_status !== undefined && history.last_status !== null) {
    const last = scanOf(history.last_status);
    if (last.order >= current.order) current = last;
  }
  if (unique[0] && (unique[0].order > current.order
    || (unique[0].order === current.order && unique[0].event.provider_code === current.event.provider_code))) current = unique[0];
  // A verified current state may be ahead of a nonempty but incomplete
  // timeline. Keep the state separately and let enabled providers fill the
  // missing scans; the summary itself never becomes a fabricated event.
  const missingCurrent = unique.length > 0 && !unique.some(scan => scan.event.provider_code === current.event.provider_code
    && scan.order + SAME_SCAN_MS >= current.order);
  const stage = rozetkaStage(String(current.event.provider_code ?? ''));
  const settled = ['ready_for_pickup', 'delivered', 'returned', 'exception', 'failed_attempt'].includes(stage ?? '')
    || current.event.provider_code === '60025';
  const pickup = ['ready_for_pickup', 'delivered'].includes(stage ?? '') ? summary.pickup : undefined;
  const time = current.event.time;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.event.description,
    provider_code: current.event.provider_code,
    last_update: time ?? null,
    ...(current.event.local_time ? { last_update_local: current.event.local_time } : {}),
    expected_delivery: !settled && summary.estimate ? summary.estimate : null,
    ...(stage === 'delivered' && time ? { delivered_at: time } : {}),
    ...(pickup ? { pickup_point: pickup } : {}),
    timezone: 'Europe/Kyiv',
    ...(!unique.length ? { summary_only: true } : {}),
    ...(unique.length > MAX_EVENTS || missingCurrent ? { history_truncated: true } : {}),
    events: unique.slice(0, MAX_EVENTS).map(scan => scan.event),
  };
}
