import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'k-line-roro';

function parseReply(body: string): unknown {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'K Line requires verification');
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SchemaError(provider, 'K Line did not return tracking JSON');
  }
}

function billNumber(row: Record<string, unknown>): string {
  return clean(row.BlPrefixCd) + clean(row.BlNum);
}

export function parseBooking(body: string, bill: string, status: number): string {
  const data = parseReply(body);
  if (status === 400 && isRecord(data) && data.Message === 'No Booking or B/L found.') throw new NotFoundError(provider);
  if (status !== 200 || !Array.isArray(data)) throw new SchemaError(provider, 'K Line omitted the bill lookup');
  if (!data.length) throw new NotFoundError(provider);
  const candidates: unknown[] = data;
  const matches = candidates.filter(isRecord).filter(row => billNumber(row) === bill);
  const bookings = [...new Set(matches.map(row => clean(row.BookingNum)))];
  if (bookings.length !== 1 || !/^[A-Z0-9-]{1,30}$/.test(bookings[0]!)) {
    throw new IndeterminateError(provider, 'K Line did not confirm one booking for this bill');
  }
  return bookings[0]!;
}

export function parseTracking(body: string, bill: string): CarrierResult {
  const data = parseReply(body);
  if (!isRecord(data) || !isRecord(data.BasicInfo) || !Array.isArray(data.Itinerary)) {
    throw new SchemaError(provider, 'K Line omitted the bill or movement list');
  }
  if (billNumber(data.BasicInfo) !== bill) throw new IndeterminateError(provider, 'K Line returned a different bill');
  const movements: unknown[] = data.Itinerary;
  const events = movements.flatMap(row => {
    if (!isRecord(row)) return [];
    const description = clean(row.MovementStatusDsc);
    const stage = scanStages.get(description);
    if (!stage) return [];
    const clock = DateTime.fromFormat(clean(row.MovementDt), 'd-LLL-yyyy H:mm', { locale: 'en-US', zone: 'utc' });
    if (!clock.isValid) return [];
    const location = /^[A-Z]{2}[A-Z0-9]{3}$/.test(clean(row.LocationCd)) ? clean(row.LocationDsc) : '';
    return [{
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm"), stage, stage_source: 'carrier_map',
      ...(location && !hasPrivateDeliveryDetails(location) && { location }),
    }];
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'K Line lists the bill without actual port movements', { reason: 'listed' });
  return {
    status: languageStageStatus(latest.stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
