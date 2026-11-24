import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { countryName } from '../../places/trackingLocation.js';
import { statusMap, uralStage } from './status.js';

export const PROVIDER = 'ural-express';
/** The lookup Ural Express's tracking page posts a JSON list of numbers to. */
export const URAL_LOOKUP = 'https://cl.ilinexpress.com/express/track/ilinePage/trackByWaybillNums';
// A delivered parcel's history is about 5 kB.
export const URAL_MAX_BYTES = 256 * 1024;

// URA, eight digits and two to four letters: the samples end in ZPRU.
const NUMBER = /^URA\d{8}[A-Z]{2,4}$/;
// "2025-09-07 09:09:52": a wall clock without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const BUSY = /频繁|too many|rate limit|限流/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;

/** A Ural Express number in capitals; anything else is not one Ural Express issues. */
export function normalizeUralNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Ural Express numbers are URA, eight digits and two to four letters');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string or null is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`Ural Express returned an invalid ${key}`);
}

/** A row's wall clock, kept as written: the rows come on more than one clock and none states its zone. */
function clockOf(raw: string): string {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    return invalid('Ural Express returned an invalid scan time');
  }
  return local;
}

/** A row's country, by its ISO code. */
function countryOf(row: Record<string, unknown>, key: string): string {
  const code = text(row, key, 8).toUpperCase();
  return /^[A-Z]{2}$/.test(code) && countryCode(code) ? code : '';
}

/**
 * The rows, newest first, as the page sorts them by their clock; a row listed twice is read once.
 * The page shows only the clock and the wording. A row's status is a code of the TMS; the rows the
 * last mile relays come without one. Its place is a country code.
 */
function scansOf(shipment: Record<string, unknown>, number: string): CarrierEvent[] {
  const rows = shipment.tracks ?? [];
  if (!Array.isArray(rows)) return invalid('Ural Express returned invalid scans');
  if (rows.length > MAX_ROWS) return invalid('Ural Express returned too many scans');
  const seen = new Set<string>();
  const scans: { local: string; index: number; event: CarrierEvent }[] = [];
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) return invalid('Ural Express returned an invalid scan');
    const named = text(row, 'waybillNum', 64);
    if (named && normalizeTrackingNumber(named).toUpperCase() !== number) {
      throw new IndeterminateError(PROVIDER, 'Ural Express answered for another shipment');
    }
    // The page leaves out a row without wording.
    const description = text(row, 'message', 300);
    if (!description) return;
    const local = clockOf(text(row, 'time', 40));
    const code = text(row, 'status', 80);
    if (code && !/^TYP_[A-Z0-9_]+$/.test(code)) return invalid('Ural Express returned an invalid scan code');
    const country = countryOf(row, 'location');
    const identity = JSON.stringify([local, code, description, country]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = uralStage(code || null, description);
    scans.push({ local, index, event: {
      local_time: local,
      description,
      ...(country ? { location: countryName(country, 'en') } : {}),
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  return scans.sort((left, right) => (left.local < right.local ? 1 : left.local > right.local ? -1 : left.index - right.index))
    .map(({ event }) => event);
}

/**
 * The reply of the tracking page's `trackByWaybillNums` call: `data` lists a shipment for each
 * number Ural Express holds, under `waybillNum`, with the marketplace's order number (`mailNo`),
 * the TMS tenant's name and the rows. A number it holds nothing under is left out of the list.
 * The order number is never read.
 */
export function parseUral(payload: unknown, raw: string): CarrierResult {
  const number = normalizeUralNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') return invalid('Ural Express returned an invalid envelope');
  if (payload.code !== 200 || payload.success !== true) {
    if (BUSY.test(clean(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Ural Express did not complete the lookup');
  }
  const shipments = payload.data;
  if (!Array.isArray(shipments) || shipments.length > MAX_SHIPMENTS || !shipments.every(isRecord)) {
    return invalid('Ural Express returned an invalid shipment list');
  }
  if (!shipments.length) throw new IndeterminateError(PROVIDER, 'Ural Express holds nothing under the number', { reason: 'portal_not_found' });
  const shipment = (shipments as Record<string, unknown>[])
    .find((candidate) => normalizeTrackingNumber(text(candidate, 'waybillNum', 64)).toUpperCase() === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'Ural Express answered for another shipment');
  const events = scansOf(shipment, number);
  const rows = (shipment.tracks ?? []) as Record<string, unknown>[];
  const destination = rows.map((row) => countryOf(row, 'toCountry')).find(Boolean);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Ural Express lists the shipment without a scan', { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time!,
    expected_delivery: null,
    ...(destination ? { destination_country: destination } : {}),
    events,
  };
}
