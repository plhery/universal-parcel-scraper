import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusMap, xingyunyiMappedStage, xingyunyiStage } from './status.js';

export const PROVIDER = 'XingYunYi';
// A long history is a few kilobytes of JSON.
export const XINGYUNYI_MAX_BYTES = 256 * 1024;

// XYY, two letters, ten digits and two letters: the numbers XingYunYi's tracker answers with an order.
const NUMBER = /^XYY[A-Z]{2}\d{10}[A-Z]{2}$/;
// "2025-03-29T22:53:50.563": a wall clock without a zone, sometimes with fractions of a second.
const CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/;
const BUSY = /频繁|too many|rate limit/i;
// The line's tracker no longer finding the line's number: a row dated when the page asks.
const LINE_NOT_FOUND = /^not found$/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;
/** Shipment statuses a parcel without scans can stand on: Transit and InfoReceived are what an order starts with. */
const SUMMARY_STAGES: ReadonlySet<Stage> = new Set(['ready_for_pickup', 'out_for_delivery', 'delivered', 'failed_attempt', 'exception']);

/** A XingYunYi number in upper case, as the tracker reads it; anything else is not one XingYunYi issues. */
export function normalizeXingyunyiNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'XingYunYi numbers are XYY, two letters, ten digits and two letters');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `XingYunYi returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's clock: an instant when the row states its offset, else its wall clock to the second. */
function clockOf(raw: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid scan time');
  }
  if (!match[3]) return { local_time: local };
  const parsed = explicitOffsetTime(`${local}${match[3]}`);
  if (!parsed) throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid scan time');
  return { time: parsed.iso };
}

/**
 * The number the line XingYunYi hands the parcel to gave it, when it is not the
 * number asked: the page shows it beside the number. The reply names no line,
 * so its carrier is named only when one carrier's high-confidence rule claims
 * the number.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const line = normalizeTrackingNumber(text(shipment, 'TrackingNumber', 64));
  if (!/^[A-Z0-9]{4,40}$/.test(line) || !/\d/.test(line) || line === number) return {};
  const detected = detectCarrierMatch(line);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'xingyunyi'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: line } : { delivery_tracking_number: line };
}

/** The scans, newest first, without the line's not-found row; each row starts with its place. */
function scansOf(shipment: Record<string, unknown>): CarrierEvent[] {
  const rows = shipment.TrackingLogs ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'XingYunYi returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'XingYunYi returned too many scans');
  const scans: { at: number; index: number; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  rows.forEach((row: unknown, index) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid scan');
    const clock = clockOf(text(row, 'TriggerTime', 40));
    const status = row.Status ?? null;
    if (status !== null && !Number.isSafeInteger(status)) throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid scan code');
    const code = status as number | null;
    const location = text(row, 'Location', 120);
    const written = text(row, 'StatusString', 300);
    // "广州 , Item outbound in sorting center.": the place, a comma, then the wording.
    const comma = written.indexOf(',');
    const shown = comma >= 0 && written.slice(0, comma).trim() === location ? written.slice(comma + 1).trim() : written;
    if (!shown) throw new SchemaError(PROVIDER, 'XingYunYi returned a scan without wording');
    if (LINE_NOT_FOUND.test(shown)) return;
    const identity = JSON.stringify([clock, code, shown, location]);
    if (seen.has(identity)) return;
    seen.add(identity);
    const staged = xingyunyiStage(shown);
    scans.push({ index, at: Date.parse(clock.time ?? `${clock.local_time}Z`), event: {
      ...clock,
      ...(location ? { location } : {}),
      description: shown,
      ...(shown !== written ? { original_description: written } : {}),
      ...(code !== null ? { provider_code: String(code) } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  });
  // The page lists scans by their clock, newest first, and keeps the reply's order for a tie.
  return scans.sort((left, right) => right.at - left.at || left.index - right.index).map(({ event }) => event);
}

/**
 * The reply of the tracking page's `GetTracking` call: `data` lists one
 * shipment per number asked, under `InputTrackingNumber`. A number XingYunYi
 * holds an order for comes with the order's id, XingYunYi's number
 * (`SystemNo`), the line's number (`TrackingNumber`), the countries, the
 * page's status for it (`LatestLogisticsStatus`) and the scans, each a clock,
 * a place and a wording that starts with the place. A number it holds no
 * order for comes back as an empty order with the id 0, no scan and the
 * status Transit: the page shows it as in transit without tracking
 * information, so it stays inconclusive.
 */
export function parseXingyunyi(payload: unknown, raw: string): CarrierResult {
  const number = normalizeXingyunyiNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid envelope');
  if (payload.code !== 200 || payload.success !== true) {
    if (BUSY.test(clean(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'XingYunYi did not complete the lookup');
  }
  const shipments = payload.data;
  if (!Array.isArray(shipments) || !shipments.length || shipments.length > MAX_SHIPMENTS || !shipments.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid shipment list');
  }
  const shipment = (shipments as Record<string, unknown>[])
    .find((candidate) => normalizeTrackingNumber(text(candidate, 'InputTrackingNumber', 64)) === number);
  if (!shipment) throw new IndeterminateError(PROVIDER, 'XingYunYi answered for another shipment');
  const id = shipment.Id;
  if (!Number.isSafeInteger(id) || (id as number) < 0) throw new SchemaError(PROVIDER, 'XingYunYi returned an invalid order id');
  const state = text(shipment, 'LatestLogisticsStatus', 40);
  const events = scansOf(shipment);
  if (id === 0) {
    if (events.length || text(shipment, 'SystemNo', 64)) throw new SchemaError(PROVIDER, 'XingYunYi returned an order without its id');
    throw new IndeterminateError(PROVIDER, 'XingYunYi holds no order under the number', { reason: 'portal_not_found' });
  }
  if (normalizeTrackingNumber(text(shipment, 'SystemNo', 64)) !== number) {
    throw new IndeterminateError(PROVIDER, 'XingYunYi answered for another shipment');
  }
  const partner = handoff(shipment, number);
  const country = countryCode(text(shipment, 'ReceiverCountryCode', 8));
  const declared = state ? xingyunyiMappedStage(state, '') : undefined;

  if (!events.length) {
    if (!declared || !SUMMARY_STAGES.has(declared)) {
      throw new NoHistoryError(PROVIDER, 'XingYunYi lists the order without a scan', {
        reason: 'listed', deliveryCarrier: partner.delivery_carrier, deliveryTrackingNumber: partner.delivery_tracking_number,
      });
    }
    return {
      status: languageStageStatus(declared), current_stage: declared, current_stage_source: 'carrier_map',
      provider_code: state, last_status_text: state, last_update: null, summary_only: true,
      ...(country ? { destination_country: country } : {}),
      ...partner,
      events: [],
    };
  }

  const newest = events[0]!;
  // A delivery stands only while no newer scan may have undone it, unless that scan moves nothing (`leadingScan`).
  const current = leadingScan(events, statusMap);
  let stage = current?.stage as Stage | undefined;
  let stageSource = current?.stage_source;
  let lastText = newest.description!;
  // The page's status for the shipment says when it is delivered, whatever its last scan's wording.
  const delivered = declared === 'delivered' && stage !== 'delivered';
  if (delivered) {
    stage = 'delivered';
    stageSource = 'carrier_map';
    lastText = state;
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: stageSource } : {}),
    ...(delivered ? { provider_code: state } : {}),
    last_status_text: lastText,
    last_update: newest.time ?? null,
    last_update_local: newest.local_time ?? null,
    ...(country ? { destination_country: country } : {}),
    ...partner,
    events,
  };
}
