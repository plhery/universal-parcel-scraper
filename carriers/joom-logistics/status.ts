import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, statusGapNote, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's code for each kind of scan, its `event`: Joom Logistics' order
 * and warehouse check-in, the legs before and after the border, the point that
 * hands the parcel over and the delivery. Relayed scans of the delivering
 * carrier often come without one.
 */
const EVENTS: ReadonlyMap<string, Stage> = new Map([
  ['informationReceived', 'registered'],
  ['parcelCheckIn', 'accepted'],
  ['originCountry', 'in_transit'],
  ['inTransit', 'in_transit'],
  ['internationalTransit', 'in_transit'],
  ['destinationCountry', 'in_transit'],
  // A post office or locker holding the parcel, and for a courier its round.
  ['issuingPoint', 'ready_for_pickup'],
  ['confirmedDelivery', 'delivered'],
]);

/**
 * Wordings, in `normalizeStatusWording` form, whose stage is not their code's,
 * and the wordings of scans that come without a code.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['order is checked-in at the warehouse', 'accepted'],
  ['package accepted at joom logistics sorting centre in hong kong', 'accepted'],
  ['package accepted at joom logistics sorting centre in shenzhen', 'accepted'],
  ['package arrived at customs', 'customs'],
  ['customs clearance of the parcel started (unitrade broker)', 'customs'],
  ['package is ready for customs clearance', 'customs'],
  ['package out for delivery', 'out_for_delivery'],
  // USPS's scans the tracker relays without a code, its out for delivery reworded.
  ['arrived shipping partner facility, usps awaiting item', 'in_transit'],
  ['departed shipping partner facility, usps awaiting item', 'in_transit'],
  ['acceptance at destination', 'in_transit'],
  ['arrival at unit', 'in_transit'],
  ['delivery in progress', 'out_for_delivery'],
  ['package is ready for shipment from the joom logistics warehouse', 'in_transit'],
  ['package handed over to postal service', 'in_transit'],
  ['parcel scanned in seko wh', 'in_transit'],
  ['package cleared customs', 'in_transit'],
  ['the order is in transit to the last mile provider.', 'in_transit'],
  ['package is being processed at the sorting centre', 'in_transit'],
  ['package processed at depot', 'in_transit'],
]);

/** The stage the map gives a scan's event code (null without one) and wording in `normalizeStatusWording` form. */
export function joomLogisticsMappedStage(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (code ? EVENTS.get(code) : undefined);
}

/** Every code and wording seen is mapped, except a note of Joom Logistics' own that moves nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => joomLogisticsMappedStage(code, wording),
  gaps: [
    { wording: 'data from the trading platform received', note: 'Joom Logistics received the order’s data from the marketplace, after it took the parcel in; it moves nothing.' },
  ],
};

/** A scan's stage: its code and wording, else the shared wording rules for one the map does not leave out, else nothing. */
export function joomLogisticsStage(code: string | null, wording: string): ClassifiedWording | null {
  const normalized = normalizeStatusWording(wording);
  const mapped = joomLogisticsMappedStage(code, normalized);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (statusGapNote(statusMap, code, normalized) !== undefined) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
