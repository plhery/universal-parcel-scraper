import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { statusMap, topestStage } from './status.js';

export const PROVIDER = 'topest';
// The sample's reply is 3 kB.
export const TOPEST_MAX_BYTES = 256 * 1024;

// Letters and digits with a digit: the tracker answers TOPEST's waybill and the delivering post's number.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;
// The number the tracker gives the delivering post, as another carrier's rules would read it.
const ONWARD = /^[A-Z0-9]{8,40}$/;
// "2026-04-11 10:08:00": a wall clock.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const MAX_ROWS = 300;

/** A number TOPEST's tracker takes: letters and digits, with a digit. */
export function normalizeTopestNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'TOPEST numbers are 8 to 30 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number): string => typeof value === 'string' ? clean(value, max) : '';

/** A row's clock as a wall clock, or its day alone when the tracker writes it at midnight. */
function clockOf(value: unknown): string {
  const parts = CLOCK.exec(text(value, 40));
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2000) return invalid('TOPEST returned an unreadable row');
  return parts[4] === '00' && parts[5] === '00' && parts[6] === '00' ? day : `${day}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/**
 * The tracker's answer for one number, `POST /price/track/` with `TrackingNo`: code `0`
 * with TOPEST's waybill in `TrackNumber`, the delivering post's number in `TrackingNo`
 * and the rows newest first, or code `1` with `暂无轨迹信息` and no rows for a number it
 * holds nothing under. The number asked must be one of the two.
 */
export function parseTopest(body: unknown, raw: string): CarrierResult {
  const number = normalizeTopestNumber(raw);
  if (!isRecord(body)) return invalid('TOPEST returned an unexpected reply');
  const code = text(body.code, 8);
  if (code === '1' && Array.isArray(body.data) && !body.data.length) throw new NotFoundError(PROVIDER, 'TOPEST has no rows under this number');
  if (code !== '0' || !Array.isArray(body.data)) return invalid('TOPEST returned an unexpected reply');
  const waybill = normalizeTrackingNumber(text(body.TrackNumber, 64));
  const onward = normalizeTrackingNumber(text(body.TrackingNo, 64));
  if (number !== waybill && number !== onward) throw new IndeterminateError(PROVIDER, 'TOPEST answered for another number');
  if (body.data.length > MAX_ROWS) return invalid('TOPEST returned too many rows');
  if (!body.data.length) throw new NoHistoryError(PROVIDER, 'TOPEST lists the number without a row', { reason: 'listed' });

  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of body.data) {
    if (!isRecord(row)) return invalid('TOPEST returned an unreadable row');
    const description = text(row.DetailDesc, 500);
    if (!description) return invalid('TOPEST returned a row without its wording');
    const local = clockOf(row.OccurTime);
    const location = text(row.Location, 120);
    const key = JSON.stringify([local, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = topestStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }

  // The tracker lists the rows newest first; rows written in the same second keep its order.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const match = ONWARD.test(onward) && onward !== waybill ? detectCarrierMatch(onward) : null;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source ?? 'carrier_map' } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...(match && match.confidence === 'high' && match.carrier !== 'unknown' && match.carrier !== PROVIDER
      ? { delivery_carrier: match.carrier, delivery_tracking_number: onward } : {}),
    events,
  };
}
