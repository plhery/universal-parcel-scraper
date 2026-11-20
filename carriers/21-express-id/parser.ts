import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { twentyOneExpressStage } from './status.js';

export const PROVIDER = '21-express-id';
// A reply with ten rows is about 6 kB.
export const MAX_BYTES = 256_000;
const MAX_ROWS = 300;
// The tracker's own examples and the waybills it answers for are twelve digits.
const NUMBER = /^\d{12}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// "18-05": the tracker writes a row's hour and minute with a hyphen.
const CLOCK = /^([01]\d|2[0-3])[-:.]([0-5]\d)$/;

/** A waybill as the tracker takes it: twelve digits. */
export function normalizeTwentyOneExpressNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.replace(/[\s-]+/g, '') : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a 21 Express waybill of 12 digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

type Row = CarrierEvent & { local_time: string; description: string };

// Each row also names the shipper, the consignee, the courier and whoever scanned the parcel,
// which the adapter leaves out. On the row of the delivery, the scanner is whoever took it.
function row(value: unknown, number: string): { event: Row; by: string } {
  if (!isRecord(value)) return invalid('21 Express returned an unreadable row');
  if (clean(value.code, 64) !== number) throw new IndeterminateError(PROVIDER, '21 Express answered for another waybill');
  const day = DAY.exec(clean(value.status_date, 20));
  const clock = CLOCK.exec(clean(value.status_time, 20));
  const date = day ? calendarDay(Number(day[1]), Number(day[2]), Number(day[3])) : null;
  const year = Number(day?.[1]);
  const type = clean(value.status_type, 80).toUpperCase();
  if (!date || !clock || year < 2001 || year > 2100 || !type) return invalid('21 Express returned an unreadable row');
  const stage = twentyOneExpressStage(type);
  return { event: { local_time: `${date}T${clock[1]}:${clock[2]}:00`, description: type, provider_code: type,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) }, by: clean(value.status_by, 120) };
}

/** Reads the tracker's detail reply for a waybill. */
export function parseTwentyOneExpress(body: unknown, number: string): CarrierResult {
  if (!isRecord(body) || !Array.isArray(body.pod) || !Array.isArray(body.status)) return invalid('21 Express returned an invalid reply');
  const pod: unknown[] = body.pod;
  const summaries: unknown[] = body.status;
  if (pod.length > MAX_ROWS || summaries.length > MAX_ROWS) return invalid('21 Express returned too many rows');
  // The tracker answers a waybill it does not know with two empty lists.
  if (pod.length === 0 && summaries.length === 0) throw new NotFoundError(PROVIDER, '21 Express does not know this waybill');
  if (summaries.length > 0 && !summaries.some((entry) => isRecord(entry) && clean(entry.code, 64) === number)) {
    throw new IndeterminateError(PROVIDER, '21 Express answered for another waybill');
  }
  if (pod.length === 0) throw new IndeterminateError(PROVIDER, '21 Express listed the waybill without its rows');

  // The tracker lists the rows oldest first, and dates several alike to the minute.
  const seen = new Set<string>();
  const read = pod.map((value, index) => ({ ...row(value, number), index })).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || b.index - a.index);
  const events = read.map(({ event }) => event);
  const newest = events[0]!;
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const signedBy = stage === 'delivered' ? read.find(({ event }) => event.stage === 'delivered')?.by : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(signedBy ? { signed_by: signedBy } : {}),
    destination_country: 'ID',
    events,
  };
}
