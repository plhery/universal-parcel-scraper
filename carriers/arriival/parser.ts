import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { arriivalStage } from './status.js';

export const PROVIDER = 'arriival';
// A waybill's reply is a few kilobytes; its scans are bounded below.
export const ARRIIVAL_MAX_BYTES = 256 * 1024;

// The tracker's page takes 4 to 40 letters, digits and dashes and upper-cases them; dashes are separators here.
const NUMBER = /^[A-Z0-9]{4,40}$/;
// The reply's `code`: 200 answers the waybill, 301 is the tracker's "Tracking Number does not exist".
const FOUND = 200;
const NOT_FOUND = 301;
// "2026-09-22 18:19:02": a scan's wall clock, with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const CODE = /^\d{1,3}$/;
// A Malaysian mobile number, as the tracker's page finds them in a scan's wording.
const PHONE = /(?:\+?\b60|\b0)1\d[\s-]?\d{3,4}[\s-]?\d{4}\b/;
const SENTENCE = /(?<=[.!?])\s+/;
const MAX_SCANS = 300;

/** A waybill number for Arriival's tracker. */
export function normalizeArriivalNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Arriival tracking number');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/**
 * The waybill a reply holds. Code 301 is the tracker's answer for a number it does not hold; any other code, such as
 * 407 "Operation failed" for a request it could not read, says nothing about the waybill.
 */
export function arriivalWaybill(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.code !== 'number') return invalid('Arriival returned an unreadable reply');
  if (payload.code === NOT_FOUND) throw new NotFoundError(PROVIDER, 'Arriival has no waybill under this number');
  if (payload.code !== FOUND) throw new IndeterminateError(PROVIDER, `Arriival refused the lookup with code ${payload.code}`);
  return isRecord(payload.data) ? payload.data : invalid('Arriival returned a reply without its waybill');
}

/** A scan's wording without the sentence that gives the driver's phone. */
function wordingOf(text: string): string {
  return text.split(SENTENCE).filter((sentence) => !PHONE.test(sentence)).join(' ').trim();
}

function eventOf(scan: unknown): CarrierEvent & { local_time: string } {
  if (!isRecord(scan)) return invalid('Arriival returned an invalid scan');
  const clock = CLOCK.exec(clean(scan.orderTime, 40));
  const day = clock ? calendarDay(Number(clock[1]), Number(clock[2]), Number(clock[3])) : null;
  if (!clock || !day) return invalid('Arriival returned an invalid scan time');
  const code = cleanScalar(scan.orderStatus, 8);
  if (!CODE.test(code)) return invalid('Arriival returned an invalid scan code');
  const description = wordingOf(clean(scan.orderDescription, 500)) || code;
  const stage = arriivalStage(code);
  return { local_time: `${day}T${clock[4]}:${clock[5]}:${clock[6]}`, description, provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
}

/**
 * Reads the tracker's reply for one waybill. Scans keep their wall clock, as the reply gives no zone, and name no
 * place. The sender, the recipient, the delivery address, the driver's phone and the proof-of-delivery photos stay
 * behind.
 */
export function parseArriival(payload: unknown, number: string): CarrierResult {
  const waybill = arriivalWaybill(payload);
  if (typeof waybill.wbno !== 'string' || normalizeTrackingNumber(waybill.wbno) !== number) {
    throw new IndeterminateError(PROVIDER, 'Arriival answered for another waybill');
  }
  const scans = waybill.trackingtlist ?? [];
  if (!Array.isArray(scans) || scans.length > MAX_SCANS) return invalid('Arriival returned an invalid scan list');
  // The tracker lists scans oldest first and can repeat one. Its page drops the repeats and shows the newest first,
  // the higher code first within a second, as a parcel's codes rise with its progress.
  const seen = new Set<string>();
  const events = scans.map(eventOf).filter((event) => {
    const key = `${event.local_time}|${event.description}`;
    return !seen.has(key) && Boolean(seen.add(key));
  }).reverse().sort((a, b) => b.local_time.localeCompare(a.local_time) || Number(b.provider_code) - Number(a.provider_code));
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'Arriival lists the waybill without scans', { reason: 'listed' });
  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const service = clean(waybill.DeliveryType, 120).replace(/^Delivery Type\s*-\s*/i, '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: events[0]!.provider_code!,
    last_status_text: events[0]!.description ?? null,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    events,
  };
}
