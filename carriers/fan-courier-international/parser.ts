import { DateTime } from 'luxon';
import { isFanCourierInternationalNumber } from '../../core/detection/fanCourierInternational.js';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { returnedTrackingNumber } from '../../core/detection/returned.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fanCourierInternationalStage } from './status.js';

export const PROVIDER = 'FAN Courier International';

const ZONE = 'Europe/Bucharest';
const MAX_EVENTS = 300;
// The tracker's headline statuses that end a shipment, whatever code came before.
const SETTLED: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['delivered', 'delivered'], ['returned', 'returned'], ['canceled', 'exception'], ['cancelled', 'exception'], ['exception', 'exception'],
]);

/** Sixteen digits, an F and four digits, as the tracker echoes them. */
export function normalizeFanCourierInternationalNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!isFanCourierInternationalNumber(number)) {
    throw new InvalidInputError(PROVIDER, 'FAN Courier International requires sixteen digits, an F and four digits');
  }
  return number;
}

/**
 * An event's instant. The page shows `event_date`, Unix seconds, and falls
 * back on `date`, the Bucharest wall clock the system wrote the event at,
 * which can be half an hour later for a code received from the network.
 */
function instant(row: Record<string, unknown>): { time?: string; local_time?: string } {
  const seconds = typeof row.event_date === 'string' && /^\d{9,10}$/.test(row.event_date) ? Number(row.event_date) : row.event_date;
  if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0) {
    const time = DateTime.fromSeconds(seconds, { zone: ZONE });
    const iso = time.isValid ? time.toISO({ suppressMilliseconds: true }) : null;
    if (iso) return { time: iso };
  }
  const text = clean(row.date, 32);
  const wall = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? DateTime.fromFormat(text, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  const local = wall?.isValid ? wall.toISO({ includeOffset: false, suppressMilliseconds: true }) : null;
  if (local) return { local_time: local };
  throw new SchemaError(PROVIDER, 'FAN Courier International returned an event without its time');
}

/**
 * The tracker's refusal of a number, with HTTP 401 or 404: NOT_FOUND names the
 * number it looked for at the end of its message.
 */
export function readFanCourierInternationalRefusal(payload: unknown, raw: string): never {
  const number = normalizeFanCourierInternationalNumber(raw);
  if (!isRecord(payload) || payload.error !== 'NOT_FOUND') {
    throw new SchemaError(PROVIDER, 'FAN Courier International refused the lookup without saying why');
  }
  const named = /:\s*([A-Za-z0-9 -]{1,64})\s*$/.exec(clean(payload.message, 200))?.[1];
  if (named !== undefined && returnedTrackingNumber(named) !== number) {
    throw new SchemaError(PROVIDER, 'FAN Courier International answered for a different number');
  }
  throw new NotFoundError(PROVIDER);
}

/** The headline's stage: a settled status, else the last code received, else the status. */
function headlineStage(headline: Record<string, unknown>): Stage | undefined {
  const status = clean(headline.status, 40).toLowerCase();
  const code = clean(headline.code, 80);
  return SETTLED.get(status) ?? (code ? fanCourierInternationalStage(`CodeChanged:${code}`, '') : undefined)
    ?? (status ? fanCourierInternationalStage(`StatusChanged:${status}`, '') : undefined);
}

/**
 * The tracker's reply for one shipment: its events, each with its type, the
 * page's sentence, its hub and instant. The weight, the related and return
 * numbers and the franchise's own reply are never read.
 */
export function parseFanCourierInternational(payload: unknown, raw: string): CarrierResult {
  const number = normalizeFanCourierInternationalNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.history)) throw new SchemaError(PROVIDER, 'FAN Courier International returned no shipment');
  const record = payload.history;
  const headline = isRecord(payload.status) ? payload.status : {};
  // The record names the number asked for; a lookup by another of its numbers names that one.
  if (returnedTrackingNumber(record.no) !== number && returnedTrackingNumber(headline.request_no) !== number) {
    throw new SchemaError(PROVIDER, 'FAN Courier International answered for a different shipment');
  }
  const rows = record.history;
  if (!Array.isArray(rows) || rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'FAN Courier International returned invalid events');
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'FAN Courier International returned no events for the shipment');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // Oldest first in the reply; newest first here, equal instants keeping the reply's order.
  for (const row of [...(rows as unknown[])].reverse()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'FAN Courier International returned an invalid event');
    const code = clean(row.eventType, 80);
    const description = clean(row.description, 300);
    if (!code || !description) throw new SchemaError(PROVIDER, 'FAN Courier International returned an event without its type or sentence');
    const location = clean(row.hub_location, 100);
    const stage = fanCourierInternationalStage(code, description);
    const event: CarrierEvent = { description, provider_code: code, ...instant(row),
      ...(location ? { location } : {}), ...(stage ? { stage } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // A received code and the status change it brings share an instant, the code first:
  // the headline says which the shipment is at.
  const stage = headlineStage(headline) ?? events.find(event => event.stage)?.stage as Stage | undefined;
  const latest = (stage ? events.find(event => event.stage === stage) : undefined) ?? events[0]!;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage } : {}),
    last_status_text: latest.description ?? null, last_update: events[0]!.time ?? null, last_update_local: events[0]!.local_time ?? null,
    timezone: ZONE, events };
}
