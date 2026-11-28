import { DateTime } from 'luxon';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { stages } from './status.js';

export const provider = 'korean-air-cargo';

/** Korean Air's IATA prefix, then a seven-digit serial and its remainder by seven. */
export function normalizeKoreanAirCargoNumber(raw: string): string {
  // Waybills are often written 180-3354 4873.
  const [, serial = '', check = ''] = /^(?:180)?(\d{7})(\d)$/.exec(raw.replace(/[\s-]/g, '')) ?? [];
  if (!serial || Number(serial) % 7 !== Number(check)) {
    throw new InvalidInputError(provider, 'Enter a Korean Air Cargo air waybill beginning with 180');
  }
  return '180' + serial + check;
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const messages = (node: unknown): { code: string; text: string }[] =>
  (Array.isArray(node) ? node : []).filter(isRecord).map(message => ({ code: text(message.code), text: text(message.text) }));

/** 21 Nov 2026 14:31: the tracker shows the day from the first six characters and the time from the thirteenth. */
function clock(value: string): DateTime | undefined {
  for (const format of ['d MMM yyyy H:mm', 'd MMM yyyy H:mm:ss']) {
    const parsed = DateTime.fromFormat(value, format, { locale: 'en', zone: 'UTC' });
    if (parsed.isValid) return parsed;
  }
  return undefined;
}

interface Read { event: CarrierEvent; utc: number; index: number }

function readEvent(row: Record<string, unknown>, index: number): Read {
  const code = text(row.eventCode).toUpperCase();
  const wall = clock(text(row.eventDate));
  if (!/^[A-Z]{3}$/.test(code) || !wall) throw new SchemaError(provider, 'Korean Air Cargo returned an incomplete event');
  const description = text(row.eventDesc) || code;
  const station = text(row.arpCode).toUpperCase();
  const stage = stages.get(code);
  return {
    event: {
      description,
      local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm"),
      provider_code: code,
      ...(/^[A-Z]{3}$/.test(station) && { location: station }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    },
    utc: clock(text(row.eventDateTimeUTC))?.toMillis() ?? NaN,
    index,
  };
}

/** One entry of the tracker's `trackawb` reply, checked against the requested waybill. */
export function parseKoreanAirCargoTracking(data: unknown, number: string): CarrierResult {
  if (!isRecord(data)) throw new SchemaError(provider, 'Korean Air Cargo returned an unreadable reply');
  const refused = messages(data.messages);
  if (refused.some(message => message.code === 'ESC401')) {
    throw new IndeterminateError(provider, 'Korean Air Cargo did not accept the tracking session', { reason: 'session_rejected' });
  }
  if (!Array.isArray(data.payLoad)) {
    throw new SchemaError(provider, refused.length ? 'Korean Air Cargo refused the tracking request' : 'Korean Air Cargo omitted the air waybill');
  }
  const waybill = data.payLoad.filter(isRecord)
    .find(entry => text(entry.awbPrefix) + text(entry.awbDocNo) === number);
  if (!waybill) throw new IndeterminateError(provider, 'Korean Air Cargo returned another air waybill');

  const rows = Array.isArray(waybill.eventDetails) ? waybill.eventDetails.filter(isRecord) : [];
  if (!rows.length) {
    if (messages(waybill.bookingMessages).some(message => message.code === 'EET600')) throw new NotFoundError(provider);
    if (text(waybill.origin)) throw new NoHistoryError(provider, 'Korean Air Cargo lists the air waybill without a status', { reason: 'listed' });
    throw new SchemaError(provider, 'Korean Air Cargo returned the air waybill without its history or a message');
  }

  const read = rows.map(readEvent);
  // Each station writes its own clock; the tracker orders the statuses by the UTC clock beside it.
  const ordered = read.every(entry => Number.isFinite(entry.utc))
    ? read.sort((left, right) => (right.utc - left.utc) || (right.index - left.index))
    : read.sort((left, right) => right.event.local_time!.localeCompare(left.event.local_time!) || (right.index - left.index));
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const { event } of ordered) {
    // A booking on several flights comes once per flight.
    const key = JSON.stringify([event.provider_code, event.description, event.local_time, event.location]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // A status recorded after the delivery does not take it back.
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
