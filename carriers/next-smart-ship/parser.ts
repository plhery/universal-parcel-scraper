import { carrierIdFromPartner } from '../../core/catalog/hints.js';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { USPS_ROUTING_BARCODE, uspsPackageIdentifier } from '../../core/detection/usps.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { EXCEPTION_STATUS, nextSmartShipCurrentStage, nextSmartShipStage, nextSmartShipSummary } from './status.js';

export const PROVIDER = 'next-smart-ship';
// A long history is a few kilobytes.
export const NEXT_SMART_SHIP_MAX_BYTES = 512 * 1024;

// The tracker takes "NSS" and up to 37 more letters or digits; its numbers so far are NSS and 19 digits.
const NUMBER = /^NSS(?=[A-Z]*\d)[A-Z0-9]{6,37}$/;
// The place a line can open with: "[SPRINGFIELD GARDENS, NY 11413]", "[Shenzhen]", "[AU]".
const PLACE = /^\[([^\]]{1,120})\]\s*/;
// A bracket that names who wrote the line rather than where: "[Linehaul Agent]".
const ROLE = /\b(?:agent|partner|carrier)\b/i;
const MAX_ENTRIES = 100;
const MAX_ITEMS = 500;

/** A Next Smart Ship number, in capitals as the tracker needs it; anything else is not one it issues. */
export function normalizeNextSmartShipNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Next Smart Ship numbers start with NSS');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`Next Smart Ship returned an invalid ${key}`);
}

interface Scan { index: number; at: number; event: CarrierEvent }

/** One line of the history: its instant, its words without the place it opens with, and that place. */
function scanOf(item: unknown, index: number): Scan | null {
  if (!isRecord(item)) return invalid('Next Smart Ship returned an invalid scan');
  const content = text(item, 'content', 1000);
  const clock = explicitOffsetTime(item.timestamp) ?? invalid('Next Smart Ship returned an invalid scan time');
  const place = PLACE.exec(content);
  const description = clean(place ? content.slice(place[0].length) : content, 500);
  // A line left empty says nothing to keep.
  if (!description) return null;
  const location = place && !ROLE.test(place[1]!) ? clean(place[1], 120) : '';
  const staged = nextSmartShipStage(description);
  return { index, at: clock.timestamp, event: {
    time: clock.iso, description, ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } };
}

/**
 * The last-mile carrier's number, and that carrier when the reply names one the catalog knows
 * whose rules offer the number. A USPS routing barcode gives its package identifier.
 */
function handoff(entry: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const compact = normalizeTrackingNumber(text(entry, 'last_mile_tracking_number', 64));
  const reference = USPS_ROUTING_BARCODE.test(compact) ? uspsPackageIdentifier(compact) ?? '' : compact;
  if (!/^[A-Z0-9]{4,40}$/.test(reference) || reference === number) return {};
  const partner = carrierIdFromPartner(text(entry, 'last_mile_service_provider', 80), text(entry, 'last_mile_tracking_url', 500));
  const named = partner && partner !== PROVIDER && (detectCarrierMatch(reference).candidates as string[]).includes(partner);
  return { ...(named ? { delivery_carrier: partner } : {}), delivery_tracking_number: reference };
}

/** The entry the reply lists for the number asked: the tracker answers every number searched with one. */
function entryOf(payload: unknown, number: string): Record<string, unknown> {
  if (!isRecord(payload) || typeof payload.code !== 'number') return invalid('Next Smart Ship returned an invalid envelope');
  if (payload.code !== 0) throw new IndeterminateError(PROVIDER, 'Next Smart Ship did not complete the lookup');
  const list = isRecord(payload.data) ? payload.data.list : undefined;
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) return invalid('Next Smart Ship returned an invalid list');
  const own = list.filter((entry) => (isRecord(entry) && typeof entry.tracking_number === 'string'
    ? normalizeTrackingNumber(entry.tracking_number) === number : invalid('Next Smart Ship returned an entry without its number')));
  if (own.length === 0) throw new IndeterminateError(PROVIDER, 'Next Smart Ship answered for another number');
  if (own.length > 1) throw new IndeterminateError(PROVIDER, 'Next Smart Ship answered with several entries for the number');
  return own[0] as Record<string, unknown>;
}

/**
 * The reply of the tracker's `POST /oms/v3/tracks/v2/query` for one number. The tracker
 * shows "Logistics tracking not found" for an entry without a history, a link elsewhere or a
 * compensation flag; only an entry that holds nothing else is a missing parcel. The last mile's
 * phone and website, the origin and the days in transit are left out.
 */
export function parseNextSmartShip(payload: unknown, raw: string): CarrierResult {
  const number = normalizeNextSmartShipNumber(raw);
  const entry = entryOf(payload, number);
  const parts = entry.sub_tracks ?? [];
  if (!Array.isArray(parts)) return invalid('Next Smart Ship returned invalid packages');
  // The tracker then lists the order's packages under their own numbers instead.
  if (parts.length) throw new IndeterminateError(PROVIDER, 'Next Smart Ship split the order into packages under other numbers');
  const detail = entry.track_detail ?? null;
  if (detail !== null && !isRecord(detail)) return invalid('Next Smart Ship returned an invalid history');
  const items = detail?.items ?? [];
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return invalid('Next Smart Ship returned an invalid history');
  const compensated = entry.oms_compensation_exception ?? false;
  if (typeof compensated !== 'boolean') return invalid('Next Smart Ship returned an invalid exception flag');

  const seen = new Set<string>();
  const scans = items.map(scanOf).filter((scan): scan is Scan => {
    if (!scan) return false;
    const key = JSON.stringify([scan.event.time, scan.event.description, scan.event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  // Newest first. The reply lists the oldest first, so of two scans at one instant the later one is newer.
  const events = scans.sort((a, b) => b.at - a.at || b.index - a.index).map((scan) => scan.event);

  // The tracker shows any shipment flagged for compensation as Abnormal.
  const code = compensated ? EXCEPTION_STATUS : text(isRecord(detail) ? detail : {}, 'status', 40);
  const summary = code ? nextSmartShipSummary(code) : undefined;
  const country = text(entry, 'destination_country', 8).toUpperCase();
  const linked = text(entry, 'tracking_url', 500);
  const facts = {
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...handoff(entry, number),
    // The tracker shows it as "Estimated to be delivered before" it; no reply seen so far gave one to read.
    ...unreadEstimates({ estimated_delivery_date: text(entry, 'estimated_delivery_date', 40) }),
  };

  if (!events.length) {
    if (summary) {
      return { status: languageStageStatus(summary.stage), current_stage: summary.stage, current_stage_source: 'carrier_map',
        provider_code: code, last_status_text: summary.wording, last_update: null, expected_delivery: null, ...facts,
        summary_only: true, events: [] };
    }
    if (code) return invalid('Next Smart Ship returned an unknown status');
    // An entry that holds anything at all, such as a link to another tracker, an empty history, its countries or a
    // last-mile number, is a parcel Next Smart Ship knows without scans.
    const known = linked || (detail && Object.keys(detail).length) || country || text(entry, 'origin_country', 8)
      || text(entry, 'last_mile_service_provider', 80) || facts.delivery_tracking_number;
    if (known) {
      throw new NoHistoryError(PROVIDER, 'Next Smart Ship lists the number without scans', { reason: 'listed',
        deliveryCarrier: facts.delivery_carrier, deliveryTrackingNumber: facts.delivery_tracking_number });
    }
    // The entry it returns for any number it does not hold, which the tracker shows as "Logistics tracking not found".
    throw new NotFoundError(PROVIDER, 'Next Smart Ship has no tracking for this number');
  }

  const scanned = events.find((event) => event.stage);
  const stage = nextSmartShipCurrentStage(summary, scanned?.stage as Stage | undefined);
  const source = summary && stage === summary.stage ? 'carrier_map' : scanned?.stage_source ?? 'carrier_map';
  const newest = events[0]!;
  // A delivery's moment is its delivery scan's.
  const deliveredAt = stage === 'delivered' && scanned?.stage === 'delivered' ? scanned.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    ...facts,
    events,
  };
}
