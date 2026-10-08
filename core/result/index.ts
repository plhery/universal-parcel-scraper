/**
 * The result every adapter and provider returns, and its normalization.
 *
 * What it is: the shape contract between the carrier package and the host
 * (status, stage, estimate, sender/pickup names, weight, and the projected
 * events). What it is not: it does not classify wording or touch the
 * database; the host's sync does that after `normalizeCarrierResult`.
 * An event with no `stage` means "no explicit mapping" (see
 * ARCHITECTURE.md § Status model).
 */
import { isRecord, type JsonObject } from '../types.js';
import { CARRIER_CATALOG, STAGES } from '../../generated/catalog.js';
import { normalizeTrackingNumber } from '../detection/normalize.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../detection/usps.js';
import { deliveredToDoor } from './pickup.js';

export type CarrierStatus =
  | 'pending'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'exception'
  | 'unknown';

export interface CarrierEvent extends JsonObject {
  time?: string;
  location?: string;
  description?: string;
  stage?: string;
  /** Explicit map, wording rule, or unresolved fallback used by the adapter. */
  stage_source?: string;
  provider_code?: string;
  /**
   * Where the carrier itself puts the scanning facility, when it says so. The
   * map uses it only where it agrees with the town in `location`.
   */
  point?: EventPoint;
}

export interface EventPoint extends JsonObject {
  latitude: number;
  longitude: number;
}

export interface CarrierResult extends JsonObject {
  status?: CarrierStatus;
  current_stage?: string;
  /** How the adapter chose current_stage, when it records that decision. */
  current_stage_source?: string;
  last_status_text?: string | null;
  /** The carrier's own code for the current status, when a summary has no scan to carry it. */
  provider_code?: string;
  last_update?: string | null;
  expected_delivery?: string | null;
  expected_delivery_from?: string | null;
  sender_name?: string | null;
  receiver_name?: string | null;
  /**
   * The point the parcel waits at for collection: its name, then its address on
   * the following lines. On a delivered parcel, the point it was collected from;
   * a parcel brought to the door has none.
   */
  pickup_point?: string | null;
  delivered_at?: string | null;
  weight_kg?: number | null;
  dimensions_text?: string | null;
  /** The carrier's own name for the shipping service the parcel travels under, as its page shows it. */
  service_name?: string;
  /** A declared delivery partner, still subject to direct identity/progress confirmation. */
  delivery_carrier?: string;
  destination_country?: string;
  /** Preserve provider country labels when no verified ISO mapping is available. */
  destination_country_name?: string;
  delivery_tracking_number?: string;
  canonical_tracking_number?: string;
  international_tracking_number?: string;
  timezone?: string;
  /** An identity-bound current status without a scan history. */
  summary_only?: boolean;
  /** The carrier returned only part of a longer scan history, such as its newest scans. */
  history_truncated?: boolean;
  events?: CarrierEvent[];
}

const STATUSES = new Set<CarrierStatus>([
  'pending',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'unknown',
]);
const CURRENT_STAGES = new Set<string>(STAGES);
const OPTIONAL_TEXT_FIELDS = [
  'current_stage_source',
  'last_status_text',
  'provider_code',
  'last_update',
  'expected_delivery',
  'expected_delivery_from',
  'sender_name',
  'receiver_name',
  'pickup_point',
  'delivered_at',
  'dimensions_text',
  'canonical_tracking_number',
  'international_tracking_number',
  'timezone',
] as const;
const EVENT_TEXT_FIELDS = ['time', 'location', 'description', 'stage', 'stage_source'] as const;
const NUMBER_FIELDS = ['delivery_tracking_number', 'canonical_tracking_number', 'international_tracking_number'] as const;

/** A carrier's coordinates for a scan, or null when they are not a usable point. */
export function eventPoint(latitude: unknown, longitude: unknown): EventPoint | null {
  const number = (value: unknown) => typeof value === 'string' && value.trim() ? Number(value) : value;
  const lat = number(latitude);
  const lon = number(longitude);
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // 0,0 is a missing value, not a scan in the Gulf of Guinea.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  // Four decimals is about ten metres: a building, not a desk.
  return { latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4 };
}

export function normalizeCarrierResult(value: unknown): CarrierResult {
  if (!isRecord(value)) throw new TypeError('The carrier adapter returned an invalid response');
  const normalized: CarrierResult = { ...value };
  normalized.status = typeof value.status === 'string' && STATUSES.has(value.status as CarrierStatus)
    ? value.status as CarrierStatus
    : 'unknown';
  if (value.current_stage !== undefined) {
    if (typeof value.current_stage !== 'string' || !CURRENT_STAGES.has(value.current_stage)) {
      throw new TypeError('The carrier adapter returned an invalid current stage');
    }
    normalized.current_stage = value.current_stage;
  }

  for (const field of OPTIONAL_TEXT_FIELDS) {
    const fieldValue = normalized[field];
    if (fieldValue != null && typeof fieldValue !== 'string') {
      throw new TypeError(`The carrier adapter returned an invalid ${field.replaceAll('_', ' ')}`);
    }
  }
  const weight = normalized.weight_kg;
  if (weight != null && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
    throw new TypeError('The carrier adapter returned an invalid parcel weight');
  }
  if (typeof normalized.service_name !== 'string' || !normalized.service_name.trim() || normalized.service_name.length > 80) {
    delete normalized.service_name;
  }

  // A USPS routing barcode opens with the recipient's ZIP code. A reported
  // number keeps only the package identifier after it, and is dropped when
  // that identifier cannot be split off cleanly.
  for (const field of NUMBER_FIELDS) {
    const number = normalized[field];
    if (typeof number !== 'string' || !USPS_ROUTING_BARCODE.test(normalizeTrackingNumber(number))) continue;
    const pic = uspsPackageIdentifier(number);
    if (pic) normalized[field] = pic;
    else delete normalized[field];
  }

  // Optional routing evidence must not discard otherwise valid tracking history.
  // A carrier can report a verified downstream reference without naming the
  // operator. Preserve that independent evidence for catalog-based discovery.
  if ((normalized.delivery_carrier != null && (typeof normalized.delivery_carrier !== 'string'
      || !Object.hasOwn(CARRIER_CATALOG, normalized.delivery_carrier)))
    || (normalized.delivery_tracking_number != null && (typeof normalized.delivery_tracking_number !== 'string'
      || !/^[A-Z0-9]{4,40}$/.test(normalized.delivery_tracking_number)))) {
    delete normalized.delivery_carrier;
    delete normalized.delivery_tracking_number;
  }
  if (typeof normalized.destination_country !== 'string' || !/^[A-Z]{2}$/.test(normalized.destination_country)) {
    delete normalized.destination_country;
  }
  if (typeof normalized.destination_country_name !== 'string' || normalized.destination_country_name.length > 80) {
    delete normalized.destination_country_name;
  }
  // Completeness flags qualify the history; one that is not a boolean says nothing.
  for (const flag of ['summary_only', 'history_truncated'] as const) {
    if (typeof normalized[flag] !== 'boolean') delete normalized[flag];
  }

  const rawEvents = normalized.events ?? [];
  if (!Array.isArray(rawEvents)) {
    throw new TypeError('The carrier adapter returned invalid tracking events');
  }
  normalized.events = rawEvents.map((rawEvent) => {
    if (!isRecord(rawEvent)) {
      throw new TypeError('The carrier adapter returned an invalid tracking event');
    }
    for (const field of EVENT_TEXT_FIELDS) {
      const fieldValue = rawEvent[field];
      if (fieldValue != null && typeof fieldValue !== 'string') {
        throw new TypeError('The carrier adapter returned an invalid tracking event');
      }
    }
    const event = { ...rawEvent };
    if (event.point !== undefined) {
      const point = isRecord(event.point) ? eventPoint(event.point.latitude, event.point.longitude) : null;
      if (point) event.point = point;
      else delete event.point;
    }
    return event;
  });
  // Some carriers keep naming a pickup point on a parcel the courier brought to
  // the door: the one it waited at before going back out, or the one it would
  // have gone to.
  if (normalized.pickup_point != null && deliveredToDoor(normalized)) delete normalized.pickup_point;
  return normalized;
}
