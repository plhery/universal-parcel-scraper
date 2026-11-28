import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { arrivalCodes, stages } from './status.js';

export const provider = 'lot-cargo';

/** LOT's IATA prefix, then a seven-digit serial and its remainder by seven. */
export function normalizeLotCargoNumber(raw: string): string {
  const [, serial = '', check = ''] = /^(?:080[\s-]?)?(\d{7})(\d)$/.exec(raw.trim()) ?? [];
  if (!serial || Number(serial) % 7 !== Number(check)) {
    throw new InvalidInputError(provider, 'Enter a LOT Cargo air waybill beginning with 080');
  }
  return '080' + serial + check;
}

/** The tracker's XML comes converted to JSON, each value under `_text`. */
const text = (node: unknown): string => isRecord(node) && typeof node._text === 'string' ? node._text.trim() : '';
const rows = (node: unknown): Record<string, unknown>[] =>
  (Array.isArray(node) ? node : node == null ? [] : [node]).filter(isRecord);
const sequence = (row: Record<string, unknown>): number =>
  isRecord(row._attributes) && typeof row._attributes.sequence === 'string' ? Number(row._attributes.sequence) : NaN;

function wallClock(date: string, time: string): string | undefined {
  // 10APR22 and 16:28: the month comes in capitals.
  const day = /^(\d{2})([A-Z]{3})(\d{2})$/i.exec(date);
  if (!day || !/^\d{2}:\d{2}$/.test(time)) return undefined;
  const month = day[2]!.charAt(0).toUpperCase() + day[2]!.slice(1).toLowerCase();
  const parsed = DateTime.fromFormat(`${day[1]}${month}${day[3]} ${time}`, 'ddMMMyy HH:mm', { locale: 'en', zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm") : undefined;
}

function readEvent(row: Record<string, unknown>): CarrierEvent {
  const description = text(row.Status);
  const code = text(row.StatusCode).toUpperCase();
  const local_time = wallClock(text(row.EventDate), text(row.EventTime));
  if (!description || !local_time) throw new SchemaError(provider, 'LOT Cargo returned an incomplete event');
  // A flight's arrival is reported where it landed; bookings, acceptance and departures where it leaves.
  const station = text(arrivalCodes.has(code) ? row.Dest : row.Origin);
  const stage = stages.get(code);
  return {
    description, local_time,
    ...(code && { provider_code: code }),
    ...(/^[A-Z]{3}$/.test(station) && { location: station }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseLotCargoTracking(data: unknown, number: string): CarrierResult {
  const waybill = isRecord(data) && isRecord(data.Cargo) && isRecord(data.Cargo.Awb) ? data.Cargo.Awb : undefined;
  if (!waybill) throw new SchemaError(provider, 'LOT Cargo omitted the air waybill');
  const shown = isRecord(waybill._attributes) && typeof waybill._attributes.num === 'string'
    ? waybill._attributes.num.replace(/[\s-]/g, '') : '';
  if (shown !== number) throw new IndeterminateError(provider, 'LOT Cargo returned another air waybill');
  const error = text(waybill.ErrorMessage);
  if (error) {
    if (/^Could not find AWB\b/i.test(error)) throw new NotFoundError(provider);
    throw new SchemaError(provider, 'LOT Cargo returned an unknown error');
  }

  const segments = rows(isRecord(waybill.Segments) ? waybill.Segments.Segment : undefined);
  // Each station writes on its own clock, so the order LOT received the messages is the history's order.
  const ordered = segments.map((row, index) => ({ row, index }))
    .sort((left, right) => (sequence(right.row) - sequence(left.row)) || (right.index - left.index));
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const { row } of ordered) {
    const event = readEvent(row);
    const key = JSON.stringify([event.provider_code, event.description, event.local_time, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  if (!events.length) throw new NoHistoryError(provider);
  // A message received after the delivery does not take it back.
  const current = events.find(event => event.provider_code === 'DLV') ?? events[0]!;
  const stage = current.provider_code ? stages.get(current.provider_code) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description,
    ...(current.provider_code && { provider_code: current.provider_code }),
    last_update: null,
    last_update_local: current.local_time,
    events,
  };
}
