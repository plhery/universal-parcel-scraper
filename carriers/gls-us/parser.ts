import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { PROGRESS } from '../../core/result/partial.js';
import { newestStagedScan } from '../../core/result/unstaged.js';
import { classifyWording, languageStageStatus, type ClassifiedStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { glsUsScanStatus, glsUsShipmentStatus } from './status.js';

export const PROVIDER = 'GLS US';
export const GLS_US_MAX_BYTES = 1_000_000;

// The tracking page's own answer for a number it does not know, which it shows as it comes.
const NOT_FOUND = 'The search found no shipments that matched your criteria.';
const MAX_SHIPMENTS = 50;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
// A wall clock with optional fractions of a second and no offset, as the reply writes every clock.
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.\d{1,7})?$/;
// Unset clocks come as year 1 or 1900.
const FIRST_YEAR = 2000;

/** What the tracking page accepts: five to twenty letters and digits, spaces removed. */
export function normalizeGlsUsNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'GLS US requires a tracking number of 5 to 20 letters and digits');
  return number;
}

/** A clock of the reply as a wall time to the second; null for an unset or unreadable one. */
function wallClock(value: unknown): string | null {
  const match = WALL_CLOCK.exec(clean(value, 64));
  if (!match) return null;
  // UTC only checks the calendar fields. No zone is assigned to the wall clock.
  const parsed = DateTime.fromISO(match[1]!, { zone: 'UTC' });
  return parsed.isValid && parsed.year >= FIRST_YEAR ? parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

/** "POWAY, CA, US" or "Poway,CA,US": the scan's town, state and country, one comma and space apart. */
function place(value: unknown): string {
  return clean(value, 200).split(',').map((part) => part.trim()).filter(Boolean).join(', ').slice(0, 100);
}

interface Shipment { record: Record<string, unknown>; events: CarrierEvent[] }

function scans(record: Record<string, unknown>): CarrierEvent[] {
  const rows = record.transitDetails ?? [];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'GLS US returned an invalid scan list');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'GLS US returned an incomplete scan row');
    const description = clean(row.eventDetails, 300);
    const localTime = wallClock(row.eventDateTime);
    if (!description || !localTime) throw new SchemaError(PROVIDER, 'GLS US returned a scan without its time or wording');
    const location = place(row.location);
    const key = JSON.stringify([localTime, description, location]);
    if (seen.has(key)) continue;
    seen.add(key);
    // A wording the map does not know, such as an attempt or a return, takes the shared wording rules.
    const mapped = glsUsScanStatus(description);
    const worded = mapped ? null : classifyWording(description, 'in_transit');
    const staged = mapped ? { stage: mapped.stage, stage_source: 'carrier_map' }
      : worded && worded.source !== 'none' ? { stage: worded.stage, stage_source: worded.source } : {};
    events.push({ local_time: localTime, description, ...(location ? { location } : {}), ...staged });
  }
  // The reply lists scans newest first; the newest clock leads whatever the order.
  return events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
}

/**
 * The shipments GLS US returns for the number: only those it files under the whole number count.
 * A number reused for several shipments gives the one with the newest scan.
 */
function requestedShipment(shipments: unknown[], number: string): Shipment {
  const matching = shipments.filter(isRecord)
    .filter((record) => normalizeTrackingNumber(clean(record.trackingNumber, 64)) === number)
    .map((record) => ({ record, events: scans(record) }));
  if (!matching.length) throw new SchemaError(PROVIDER, 'GLS US did not return the requested shipment');
  if (matching.length === 1) return matching[0]!;
  const newest = (shipment: Shipment) => shipment.events[0]?.local_time ?? '';
  const ordered = [...matching].sort((left, right) => newest(right).localeCompare(newest(left)));
  if (!newest(ordered[0]!) || newest(ordered[0]!) === newest(ordered[1]!)) {
    throw new IndeterminateError(PROVIDER, 'GLS US returned several shipments for this number');
  }
  return ordered[0]!;
}

/** A staged scan's status: the map's, or the one its shared stage gives. */
function scanStatus(event: CarrierEvent): ClassifiedStatus | undefined {
  if (!event.stage) return undefined;
  return glsUsScanStatus(event.description!) ?? { status: languageStageStatus(event.stage as Stage), stage: event.stage as Stage };
}

/** The day of a delivery estimate ("2026-07-15T00:00:00"); null when unset. */
function estimateDay(value: unknown): string | null {
  return wallClock(value)?.slice(0, 10) ?? null;
}

/**
 * GLS US's tracking summaries for one number. Only the shipments filed under the whole number
 * are read. The recipient's company, contact and address, the signer, the shipper's reference,
 * proof-of-delivery and signature flags and the delivery-route widget are never read.
 */
export function parseGlsUs(payload: unknown, raw: string): CarrierResult {
  const number = normalizeGlsUsNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'GLS US returned an invalid tracking response');
  const shipments = payload.shipments ?? [];
  if (!Array.isArray(shipments) || shipments.length > MAX_SHIPMENTS) throw new SchemaError(PROVIDER, 'GLS US returned an invalid shipment list');
  if (!shipments.length) {
    if (clean(payload.message, 1_000).startsWith(NOT_FOUND)) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'GLS US returned no shipment without saying the number is unknown');
  }
  const { record, events } = requestedShipment(shipments, number);
  const summaryText = clean(record.status, 64);
  const summary = glsUsShipmentStatus(summaryText);
  const newest = events[0];
  // The newest scan with a stage, but never a delivery or a return under a newer scan without one.
  const staged = newest?.stage ? newest : newestStagedScan(events);
  const scanned = staged ? scanStatus(staged) : undefined;
  // The status can lag a scan the reply already lists: a scan further along leads.
  const current = summary && !(scanned && (PROGRESS[scanned.stage] ?? 0) > (PROGRESS[summary.stage] ?? 0)) ? summary : scanned ?? summary;
  if (!newest && !summary) throw new IndeterminateError(PROVIDER, 'GLS US returned a shipment without scans or status');
  const open = current?.status !== 'delivered' && current?.stage !== 'returned';
  const source = current && current !== summary ? staged?.stage_source ?? 'carrier_map' : 'carrier_map';
  return {
    status: current?.status ?? 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: source } : {}),
    last_status_text: newest?.description ?? summaryText,
    last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : {}),
    expected_delivery: open ? estimateDay(record.estimatedDeliveryDate) : null,
    ...(newest ? {} : { summary_only: true }),
    events: events.slice(0, MAX_EVENTS),
  };
}
