import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isWhatsShipReference } from '../../core/detection/whatsShip.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, trackingLanguageStage, type ClassifiedStatus } from '../../core/status/index.js';
import { listsNewestFirst } from '../../core/result/order.js';
import { calendarDay, countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { whatsShipStatus } from './status.js';

export const PROVIDER = 'WhatsShip';
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;
const OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const SUPPORT = /\s+For Delivery Issues (?:&|and) Tracking Support, Contact GOFO at\b[\s\S]*$/i;

export function normalizeWhatsShipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isWhatsShipReference(number)) throw new InvalidInputError(PROVIDER, 'WhatsShip requires a WS order reference');
  return number;
}

function text(row: Record<string, unknown>, key: string, limit: number, required = false): string {
  const value = row[key];
  if (value === undefined || value === null) {
    if (!required) return '';
    throw new SchemaError(PROVIDER, 'WhatsShip returned an incomplete scan');
  }
  if (typeof value !== 'string' || value.length > limit) throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid scan field');
  const result = clean(value, limit);
  if (required && !result) throw new SchemaError(PROVIDER, 'WhatsShip returned an incomplete scan');
  return result;
}

function offset(value: string): string {
  const result = value === 'UTC' || value === 'Z' ? 'Z' : value.replace(/^UTC/, '');
  if (result !== 'Z' && (!OFFSET.test(result) || (result.slice(1, 3) === '14' && result.slice(4) !== '00'))) {
    throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid scan offset');
  }
  return result;
}

/** The scan code's step, or for a scan without one the step its wording names. */
function scanStatus(code: string, description: string): (ClassifiedStatus & { source: 'carrier_map' | 'wording:language' }) | undefined {
  if (code) {
    const mapped = whatsShipStatus(code, description);
    return mapped && { ...mapped, source: 'carrier_map' };
  }
  const stage = trackingLanguageStage(description);
  return stage && { stage, status: languageStageStatus(stage), source: 'wording:language' };
}

interface Scan {
  event: CarrierEvent;
  at: number;
  local: boolean;
  index: number;
}

function scan(row: Record<string, unknown>, index: number): Scan {
  const raw = text(row, 'ProcessDate', 64, true);
  const parts = CLOCK.exec(raw);
  if (!parts || !calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3]))) {
    throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid scan clock');
  }
  const ownOffset = parts[4] ? offset(parts[4]) : '';
  const zone = text(row, 'ProcessTimezone', 16);
  const rowOffset = zone ? offset(zone) : '';
  const minutes = (value: string) => value === 'Z' ? 0 : (value[0] === '-' ? -1 : 1) * (Number(value.slice(1, 3)) * 60 + Number(value.slice(4)));
  if (ownOffset && rowOffset && minutes(ownOffset) !== minutes(rowOffset)) {
    throw new SchemaError(PROVIDER, 'WhatsShip returned conflicting scan offsets');
  }
  const parsed = ownOffset || rowOffset ? explicitOffsetTime(ownOffset ? raw : `${raw}${rowOffset}`) : null;
  if ((ownOffset || rowOffset) && !parsed) throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid scan clock');
  // The feed WhatsShip relays for some partners' orders names no scan code; its wording names the step.
  const code = row.TrackNodeCode === undefined || row.TrackNodeCode === null ? '' : text(row, 'TrackNodeCode', 80, true);
  const description = text(row, 'ProcessContent', 2_000, true).replace(SUPPORT, '').trim().slice(0, 500);
  if (!description) throw new SchemaError(PROVIDER, 'WhatsShip returned a scan without milestone wording');
  const current = scanStatus(code, description);
  const location = [...new Set(['ProcessCity', 'ProcessProvince', 'ProcessCountry'].map(key => text(row, key, 120)).filter(Boolean))].join(', ');
  return {
    event: { ...(parsed ? { time: parsed.iso } : { local_time: raw }), description, ...(code ? { provider_code: code } : {}),
      ...(location ? { location } : {}), ...(current ? { stage: current.stage, stage_source: current.source } : {}) },
    // A local clock is read in UTC here only to compare its digits with other local clocks.
    at: parsed?.timestamp ?? Date.parse(`${raw}Z`), local: !parsed, index,
  };
}

/** Keep source order for ties; its observed list runs from oldest to newest. */
function newestFirst(scans: Scan[]): Scan[] {
  const direction = listsNewestFirst(scans.map(({ event }) => event));
  if (scans.every(({ local }) => local === scans[0]!.local)) {
    return scans.sort((left, right) => right.at - left.at || (direction === true ? left.index - right.index : right.index - left.index));
  }
  // Unknown offsets cannot be compared to instants. The feed's own monotone
  // order can place them, but a shuffled or directionless mixture cannot.
  if (direction === null) throw new IndeterminateError(PROVIDER, 'WhatsShip returned history with an unresolved clock order');
  const ordered = direction ? scans : scans.reverse();
  const previous = new Map<boolean, number>();
  for (const { local, at } of ordered) {
    const before = previous.get(local);
    if (before !== undefined && at > before) throw new IndeterminateError(PROVIDER, 'WhatsShip returned history with an inconsistent clock order');
    previous.set(local, at);
  }
  return ordered;
}

/** The official guest read binds WhatsShip's order reference, not a partner's alias. */
export function parseWhatsShip(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeWhatsShipNumber(rawNumber);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid envelope');
  if (payload.error === 'Tracking number not exist!' && payload.status === 422
    && Object.keys(payload).length === 2) throw new NotFoundError(PROVIDER);
  if (Object.hasOwn(payload, 'error') || (Object.hasOwn(payload, 'status') && payload.status !== 200)) {
    throw new IndeterminateError(PROVIDER, 'WhatsShip did not complete the lookup');
  }
  if (!isRecord(payload.Item)) throw new SchemaError(PROVIDER, 'WhatsShip returned no shipment record');
  const item = payload.Item;
  if (typeof item.OrderNumber !== 'string' || item.OrderNumber.length > 64
    || !isWhatsShipReference(item.OrderNumber) || normalizeTrackingNumber(item.OrderNumber) !== number) {
    throw new SchemaError(PROVIDER, 'WhatsShip returned another whole order reference');
  }
  if (!Array.isArray(item.OrderTrackingDetails) || item.OrderTrackingDetails.length > MAX_ROWS || !item.OrderTrackingDetails.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'WhatsShip returned an invalid or oversized scan history');
  }
  if (!item.OrderTrackingDetails.length) throw new NoHistoryError(PROVIDER, 'WhatsShip lists the order without scans', { reason: 'listed' });
  const seen = new Set<string>();
  const events = newestFirst(item.OrderTrackingDetails.map(scan)).map(({ event }) => event).filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const latest = events[0]!;
  // Neither the envelope's TimeStamp nor an older delivery advances the latest scan.
  const current = scanStatus(latest.provider_code ?? '', String(latest.description));
  const destination = countryCode(item.CountryCode);
  return { status: current?.status ?? 'unknown', ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    ...(latest.provider_code ? { provider_code: latest.provider_code } : {}), last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, ...(current?.stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(destination ? { destination_country: destination } : {}),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS) };
}
