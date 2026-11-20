import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { golillaStage } from './status.js';

export const PROVIDER = 'Golilla';
// A history is a few kilobytes; a shipment of bulky goods has a few parcels.
export const GOLILLA_MAX_BYTES = 1024 * 1024;
const ZONE = 'Europe/Rome';
// The shipment's number (`ldv`), a whole number the tracker counts up: seven digits, eight once it grows.
const NUMBER = /^[1-9]\d{6,7}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// A parcel's repeated scan: the same code at the same branch within a minute.
const REPEAT_MS = 60_000;
const MAX_PARCELS = 200;
const MAX_ROWS = 1000;
const MAX_EVENTS = 100;

/** A number for Golilla's tracker; anything else is not one it issues. */
export function normalizeGolillaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Golilla shipment numbers are seven or eight digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Golilla returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A whole, nonnegative number the reply must give, such as a shipment number or an event code. */
function whole(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new SchemaError(PROVIDER, `Golilla returned an invalid ${what}`);
  return value;
}

/** A UTC instant, as the page reads it, at Italy's offset. */
function instant(value: unknown): DateTime | null {
  const parsed = typeof value === 'string' && INSTANT.test(value) ? DateTime.fromISO(value, { setZone: true }) : null;
  return parsed?.isValid ? parsed.setZone(ZONE) : null;
}

const iso = (time: DateTime) => time.toISO({ suppressMilliseconds: true })!;

interface Scan { at: number; code: number; branch: string; event: CarrierEvent }

/** One of a parcel's `esiti`. The staff member who entered it is not read. */
function projectScan(row: unknown): Scan {
  if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Golilla returned an invalid scan');
  const time = instant(row.eventDateTime);
  if (!time) throw new SchemaError(PROVIDER, 'Golilla returned an invalid scan time');
  const code = whole(row.codEsito, 'event code');
  const description = text(row, 'descEsito');
  if (!description) throw new SchemaError(PROVIDER, 'Golilla returned a scan without wording');
  const location = text(row, 'descFiliale', 120);
  const staged = golillaStage(String(code), description);
  return {
    at: time.toMillis(), code, branch: text(row, 'filiale', 40) || location,
    event: {
      time: iso(time),
      ...(location ? { location } : {}),
      description,
      provider_code: String(code),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
  };
}

/** The scans of each parcel (`colli`), oldest first. */
function parcelScans(tracking: Record<string, unknown>): Scan[][] {
  const parcels = tracking.colli ?? [];
  if (!Array.isArray(parcels)) throw new SchemaError(PROVIDER, 'Golilla returned invalid parcels');
  if (parcels.length > MAX_PARCELS) throw new SchemaError(PROVIDER, 'Golilla returned too many parcels');
  let rows = 0;
  return parcels.map((parcel) => {
    if (!isRecord(parcel)) throw new SchemaError(PROVIDER, 'Golilla returned an invalid parcel');
    const scans = parcel.esiti ?? [];
    if (!Array.isArray(scans)) throw new SchemaError(PROVIDER, 'Golilla returned a parcel with invalid scans');
    rows += scans.length;
    if (rows > MAX_ROWS) throw new SchemaError(PROVIDER, 'Golilla returned an oversized history');
    return scans.map(projectScan).sort((a, b) => a.at - b.at);
  });
}

/**
 * The shipment's history, newest first. Each parcel of a shipment has its own
 * scans, which mostly repeat the others' a second or two apart; a scan is kept
 * once per branch and code within a minute.
 */
function history(parcels: Scan[][]): Scan[] {
  const kept: Scan[] = [];
  for (const scan of parcels.flat().sort((a, b) => a.at - b.at)) {
    const repeat = kept.some((other) => other.code === scan.code && other.branch === scan.branch && scan.at - other.at <= REPEAT_MS);
    if (!repeat) kept.push(scan);
  }
  return kept.reverse();
}

/**
 * The stage the shipment is at: the newest staged scan of each parcel, and of
 * those, the newest that is not a delivery. One parcel delivered does not
 * deliver the shipment while another is still on its way.
 */
function currentScan(parcels: Scan[][]): Scan | undefined {
  const currents = parcels.map((scans) => [...scans].reverse().find((scan) => scan.event.stage))
    .filter((scan): scan is Scan => scan !== undefined);
  const open = currents.filter((scan) => scan.event.stage !== 'delivered');
  return (open.length ? open : currents).reduce<Scan | undefined>((newest, scan) => (!newest || scan.at > newest.at ? scan : newest), undefined);
}

/** A calendar day the reply gives, or null. */
function day(tracking: Record<string, unknown>, key: string): string | null {
  const value = text(tracking, key, 16);
  return DATE.test(value) && DateTime.fromISO(value, { zone: 'UTC' }).isValid ? value : null;
}

/**
 * The delivery day: the one the page shows over the history when the reply
 * has it, else the planned day as last updated, else the first planned.
 */
function estimate(tracking: Record<string, unknown>): string | null {
  return day(tracking, 'estimatedArrivalDate') ?? day(tracking, 'dataPrevistaConsegnaAggiornata') ?? day(tracking, 'dataPrevistaConsegnaTeorica');
}

/** The slot on the delivery day, which the adapter does not read yet: named when the reply fills its start or finish. */
function unreadSlot(tracking: Record<string, unknown>): Pick<CarrierResult, 'unread_estimates'> {
  return unreadEstimates({
    estimatedArrivalTimeStart: tracking.estimatedArrivalTimeStart, estimatedArrivalTimeFinish: tracking.estimatedArrivalTimeFinish,
  });
}

/** The shipment's summary: the event the reply files the shipment under, with its time, or null when it names none. */
function summaryScan(tracking: Record<string, unknown>): Scan | null {
  if (tracking.codEvento === null || tracking.codEvento === undefined) return null;
  return projectScan({ eventDateTime: tracking.dateTimeEv, codEsito: tracking.codEvento, descEsito: tracking.descEvento });
}

/**
 * The reply of the tracker's `/tracking/{number}` for one shipment, which must
 * give back the shipment asked. The recipient's town, province, postcode and
 * position, the sender and its references, the parcels' references, the staff,
 * the proof of delivery and the shipment's progress steps are not kept.
 */
export function parseGolilla(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGolillaNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.status)) throw new SchemaError(PROVIDER, 'Golilla returned an invalid envelope');
  if (payload.status.code !== 200) throw new IndeterminateError(PROVIDER, 'Golilla did not complete the lookup');
  const tracking = payload.tracking;
  if (!isRecord(tracking)) throw new SchemaError(PROVIDER, 'Golilla returned a reply without a shipment');
  if (whole(tracking.ldv, 'shipment number') !== Number(number)) throw new IndeterminateError(PROVIDER, 'Golilla answered for another shipment');

  const parcels = parcelScans(tracking);
  const scans = history(parcels);
  if (!scans.length) {
    // A shipment whose parcels have no scan yet still has its summary's event.
    const summary = summaryScan(tracking);
    if (!summary) throw new NoHistoryError(PROVIDER);
    const stage = summary.event.stage as Stage | undefined;
    return {
      status: stage ? languageStageStatus(stage) : 'unknown',
      ...(stage ? { current_stage: stage, current_stage_source: summary.event.stage_source! } : {}),
      last_status_text: summary.event.description!,
      provider_code: summary.event.provider_code!,
      last_update: summary.event.time!,
      expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(tracking),
      ...unreadSlot(tracking),
      summary_only: true,
      events: [],
    };
  }
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  const current = currentScan(parcels);
  const stage = current?.event.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.event.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: stage === 'delivered' || stage === 'returned' ? null : estimate(tracking),
    ...unreadSlot(tracking),
    ...(stage === 'delivered' ? { delivered_at: events.find((event) => event.stage === 'delivered')!.time! } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
