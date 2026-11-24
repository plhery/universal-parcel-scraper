import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { joomLogisticsStage, statusMap } from './status.js';

export const PROVIDER = 'Joom Logistics';
// A long history is a few kilobytes of JSON.
export const JOOM_LOGISTICS_MAX_BYTES = 256 * 1024;

// The number of the post or line that carries the parcel: letters and digits, at least one a digit.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{4,40}$/;
// "2023-03-08T06:10:00Z", "2024-02-03T12:25:31.011Z": every clock is labelled UTC.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/;
const MAX_ROWS = 300;
const MAX_NUMBERS = 20;

/** The codes of Joom Logistics' own order system and warehouse check-in. */
const OWN_EVENTS: ReadonlySet<string> = new Set(['informationReceived', 'parcelCheckIn']);
/** The codes of scans before the parcel leaves, which Joom Logistics' sorting centres write with their country. */
const ORIGIN_EVENTS: ReadonlySet<string> = new Set(['originCountry', 'inTransit']);

/** A number in upper case, as the tracker reads it; it finds nothing in lower case. */
export function normalizeJoomLogisticsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Joom Logistics tracks a parcel by its carrier’s number of four to forty letters and digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Joom Logistics returned an invalid ${key}`);
  return clean(value, maxLength);
}

/**
 * Whether a scan is Joom Logistics' own, its Z a true UTC instant: the order
 * and warehouse check-in, and its sorting centres' scans before the parcel
 * leaves, which carry their country. The carriers it relays, flights and
 * lines before the border and posts and couriers after it, write their wall
 * clock under the Z and name no country before the border, and the scans
 * after it come with codes of their own. Without the destination, a country
 * cannot be placed before the border, and the scan keeps its wall clock.
 */
function ownScan(event: string, country: string | null, destination: string | null): boolean {
  return OWN_EVENTS.has(event) || (ORIGIN_EVENTS.has(event) && country !== null && destination !== null && country !== destination);
}

/** A scan's clock: an instant for Joom Logistics' own scan, the wall clock under the Z for a relayed one. */
function clockOf(raw: string, own: boolean): Pick<CarrierEvent, 'time' | 'local_time'> {
  const match = CLOCK.exec(raw);
  const wall = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only.
  if (!match || DateTime.fromISO(wall, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== wall) {
    throw new SchemaError(PROVIDER, 'Joom Logistics returned an invalid scan time');
  }
  return own ? { time: `${wall}Z` } : { local_time: wall };
}

/**
 * The number of the carrier that delivers the parcel, when it is not the
 * number asked: the page shows it as the actual tracking number. The reply
 * names no carrier for it, so one is named only when one carrier's
 * high-confidence rule claims the number.
 */
function handoff(data: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const actual = normalizeTrackingNumber(text(data, 'actualTrackingNumber', 64));
  if (!NUMBER.test(actual) || actual === number) return {};
  const detected = detectCarrierMatch(actual);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'joom-logistics'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: actual } : { delivery_tracking_number: actual };
}

/** The parcel's own numbers as the reply lists them, the first the one it is filed under. */
function parcelNumbers(data: Record<string, unknown>): Set<string> {
  const listed = normalizeTrackingNumber(text(data, 'trackingNumber', 64));
  if (!listed) throw new SchemaError(PROVIDER, 'Joom Logistics returned a parcel without its number');
  const others = data.trackingNumbers ?? [];
  if (!Array.isArray(others) || others.length > MAX_NUMBERS || !others.every((other) => typeof other === 'string')) {
    throw new SchemaError(PROVIDER, 'Joom Logistics returned invalid parcel numbers');
  }
  return new Set([listed, ...others.map((other) => normalizeTrackingNumber(clean(other, 64)))]);
}

/** The scans, newest first as the page sorts them by their labelled clock, a scan listed twice once. */
function scansOf(data: Record<string, unknown>, destination: string | null): CarrierEvent[] {
  const rows = data.checkpoints ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Joom Logistics returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Joom Logistics returned too many scans');
  const scans: { at: number; index: number; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Joom Logistics returned an invalid scan');
    const written = text(row, 'operationTime', 40);
    const code = text(row, 'event', 40);
    const country = countryCode(text(row, 'country', 8));
    const clock = clockOf(written, ownScan(code, country, destination));
    const description = text(row, 'message', 300);
    if (!description) throw new SchemaError(PROVIDER, 'Joom Logistics returned a scan without wording');
    // The page shows the place after the country; the country alone when that is all the scan names.
    const place = text(row, 'location', 120);
    const location = place && country && !place.toUpperCase().endsWith(`, ${country}`) ? `${place}, ${country}` : place || country || '';
    const identity = JSON.stringify([clock, code, description, location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = joomLogisticsStage(code || null, description);
    scans.push({ index, at: Date.parse(written), event: {
      ...clock,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // The reply lists scans oldest first; a tie keeps that order, read backwards.
  return scans.sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);
}

/**
 * The reply of the tracker's `GET /api/0.1/trackings`: under `data`, the number
 * the parcel is filed under (`trackingNumber`) and its other numbers, the
 * number its delivering carrier tracks it by (`actualTrackingNumber`), the
 * countries, whether it is delivered and the scans (`checkpoints`), oldest
 * first. Each scan has a clock labelled UTC, an event code, the country and
 * place when known, and a wording. The tracker answers a number it does not
 * know with HTTP 404, which the adapter reads.
 */
export function parseJoomLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJoomLogisticsNumber(raw);
  if (!isRecord(payload) || !isRecord(payload.data)) throw new SchemaError(PROVIDER, 'Joom Logistics returned an invalid reply');
  const data = payload.data;
  if (!parcelNumbers(data).has(number)) throw new IndeterminateError(PROVIDER, 'Joom Logistics answered for another parcel');
  const delivered = data.delivered ?? false;
  if (typeof delivered !== 'boolean') throw new SchemaError(PROVIDER, 'Joom Logistics returned an invalid delivery flag');
  const destination = countryCode(text(data, 'destinationCountry', 8));
  const partner = handoff(data, number);
  const events = scansOf(data, destination);

  if (!events.length) {
    if (!delivered) {
      throw new NoHistoryError(PROVIDER, 'Joom Logistics lists the parcel without a scan', {
        reason: 'listed', deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number,
      });
    }
    return {
      status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: null, last_update: null, summary_only: true,
      ...(destination ? { destination_country: destination } : {}),
      ...partner,
      events: [],
    };
  }

  const newest = events[0]!;
  // A delivery stands only while no newer scan may have undone it, unless that scan moves nothing (`leadingScan`).
  const current = leadingScan(events, statusMap);
  let stage = current?.stage as Stage | undefined;
  let stageSource = current?.stage_source;
  // The reply's flag says when the parcel is delivered, whatever its last scan's wording.
  if (delivered && stage !== 'delivered') {
    stage = 'delivered';
    stageSource = 'carrier_map';
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: stageSource } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    ...(destination ? { destination_country: destination } : {}),
    ...partner,
    events,
  };
}

/**
 * The tracker's answer to a number it does not know: HTTP 404 with
 * `api.not_found` and a message that names the number asked. Anything else
 * under a 404 is not that answer.
 */
export function isJoomLogisticsNotFound(payload: unknown, number: string): boolean {
  if (!isRecord(payload) || payload.type !== 'api.not_found' || typeof payload.message !== 'string') return false;
  const named = /^failed to get tracking by tracking number (.+)$/.exec(clean(payload.message, 200));
  return named?.[1] === number;
}
