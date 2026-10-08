import { DateTime } from 'luxon';
import type { CarrierEvent } from '../../core/result/index.js';
import { EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import type { Stage } from '../../generated/catalog.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { event, place, text } from '../shared/result.js';

// Official v2 status vocabulary, plus TransportArrived/Departed observed in
// public China Post histories. Expired describes tracking age, not a scan.
const SUB_STAGES: Record<string, Stage> = {
  InfoReceived: 'registered',
  InTransit_PickedUp: 'accepted', InTransit_Other: 'in_transit',
  InTransit_Departure: 'in_transit', InTransit_Arrival: 'in_transit',
  InTransit_TransportArrived: 'in_transit', InTransit_TransportDeparted: 'in_transit',
  InTransit_CustomsProcessing: 'customs', InTransit_CustomsReleased: 'in_transit',
  InTransit_CustomsRequiringInformation: 'customs',
  AvailableForPickup_Other: 'ready_for_pickup', OutForDelivery_Other: 'out_for_delivery',
  DeliveryFailure_Other: 'failed_attempt', DeliveryFailure_NoBody: 'failed_attempt',
  DeliveryFailure_Security: 'failed_attempt', DeliveryFailure_Rejected: 'failed_attempt',
  DeliveryFailure_InvalidAddress: 'failed_attempt', Delivered_Other: 'delivered',
  Exception_Other: 'exception', Exception_Returning: 'exception', Exception_Returned: 'returned',
  Exception_NoBody: 'exception', Exception_Security: 'exception', Exception_Damage: 'exception',
  Exception_Rejected: 'exception', Exception_Delayed: 'exception', Exception_Lost: 'exception',
  Exception_Destroyed: 'exception', Exception_Cancel: 'exception',
};

/**
 * 17TRACK's two readings of a scan usually name one instant. When they
 * disagree, `time_iso` is the clock and offset 17TRACK shows: on India Post's
 * legs `time_utc` lands 30 minutes after it, on scans India Post itself dates.
 */
function scanTime(raw: JsonObject): unknown {
  const { time_utc: utc, time_iso: iso } = raw;
  if (typeof utc === 'string' && typeof iso === 'string' && EXPLICIT_OFFSET_PATTERN.test(iso)) {
    const shown = DateTime.fromISO(iso, { setZone: true });
    const converted = DateTime.fromISO(utc, { setZone: true });
    if (shown.isValid && converted.isValid && shown.toMillis() !== converted.toMillis()) return iso;
  }
  return utc ?? iso;
}

/**
 * Keep scan codes/operator and the origin of 17TRACK's converted timestamp.
 * `placed` is the instant a caller read from the facility's own clock instead.
 */
export function seventeenTrackEvent(raw: JsonObject, operator: JsonObject, placed?: string): CarrierEvent | null {
  // Some completed responses contain undated explanatory rows alongside real
  // scans. Skip only absent dates; malformed nonempty timestamps still fail.
  const time = placed ?? scanTime(raw);
  if (time === null || time === undefined) return null;
  const code = text(raw.sub_status);
  const mapped = Object.hasOwn(SUB_STAGES, code) ? SUB_STAGES[code] : undefined;
  const parsed = event(time, raw.description, raw.stage ?? (mapped ? code.split('_')[0] : undefined));
  if (!parsed) return null;
  // Preserve the shared delivered/negation/handoff safeguards. The specific
  // code otherwise supplies semantics that Chinese wording cannot provide.
  const genericTransit = code === 'InTransit_Other' && parsed.stage !== 'pending';
  if (mapped && !genericTransit && (mapped !== 'delivered' || parsed.stage === 'delivered')) parsed.stage = mapped;
  // 17TRACK's generic transit bucket loses Swiss Post's delivery-round scan.
  // Refine only that operator's precise native label; keep its original code.
  if (code === 'InTransit_Other' && operator.reporting_carrier === 'Swiss Post'
    && text(raw.description).toLowerCase() === 'loading into delivery vehicle') parsed.stage = 'out_for_delivery';
  if (parsed.stage === 'delivered') parsed.description = 'Delivered';
  const timeRaw = isRecord(raw.time_raw) ? raw.time_raw : null;
  // `address` is never read: it can be the recipient's street.
  const location = place(raw.location);
  return {
    ...parsed,
    ...(location ? { location } : {}),
    ...(code && /^[A-Za-z_]{1,80}$/.test(code) ? { provider_code: code } : {}),
    ...operator,
    ...(typeof raw.time_iso === 'string' ? { provider_time_iso: raw.time_iso } : {}),
    // An inferred offset remains provider-converted time, not independent
    // evidence that China Post knows the destination's local timezone.
    time_provenance: timeRaw?.timezone === null ? 'provider_inferred'
      : typeof timeRaw?.timezone === 'string' ? 'carrier_reported' : 'unspecified',
  };
}
