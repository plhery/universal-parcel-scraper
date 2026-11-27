import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// The tracker's English rows, by their `normalizeStatusWording` wording. Some name a place, a
// warehouse's address, the area a delivery station serves, or the destination by its country code
// or by a partner and country's names, before or after the fixed words.
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/(?:^|,)order information received by the carrier\.?$/, 'registered'],
  [/^consignment received at the local warehouse in .+\.$/, 'accepted'],
  [/^parcel received at the processing facility .+\.$/, 'in_transit'],
  [/^parcel sorted and ready for international dispatch .+\.$/, 'in_transit'],
  [/^parcel departed the processing facility .+\.$/, 'in_transit'],
  [/^origin processing completed \[.+\]\.$/, 'in_transit'],
  [/^shipment is ready for transfer to the departure airport\.$/, 'in_transit'],
  [/^shipment arrived at the departure airport cargo facility\.$/, 'in_transit'],
  [/^shipment handed over to the air carrier at the departure airport\.$/, 'in_transit'],
  [/^shipment departed the origin airport; international line-haul transit is in progress\.$/, 'in_transit'],
  [/^shipment arrived at [a-z][a-z ]{1,40} airport$/, 'in_transit'],
  [/^shipment arrived at the [a-z][a-z ]{1,60} destination processing facility\.$/, 'in_transit'],
  [/^shipment information has been received for destination processing\.(?: (?:[a-z][a-z ]{0,60})?\.)?$/, 'in_transit'],
  [/^arrival processing is in progress\.$/, 'in_transit'],
  [/^destination processing completed\.$/, 'in_transit'],
  [/^shipment transferred to the carrier\.$/, 'in_transit'],
  [/^shipment arrived at the local warehouse; inbound processing is in progress\.$/, 'in_transit'],
  [/^shipment entered the local delivery network\.$/, 'in_transit'],
  [/^parcel arrived at the local delivery station, serving .+\.$/, 'in_transit'],
  [/^delivery has been scheduled with the carrier\.$/, 'in_transit'],
  // Another line's rows, shorter, with the origin hub or town, or the destination's country, in brackets before or after
  // the fixed words. Its first scan is at the hub, after the order's data.
  [/^\[[^\]]{1,60}\] the order information has been sent\.?$/, 'registered'],
  [/^\[[^\]]{1,60}\] consignment received at transit point\.?$/, 'accepted'],
  [/^[a-z][a-z ]{0,40} processing center has received it \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^package has been sorted and is ready to be sent \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^about to be sent to the \[[^\]]{1,60}\] warehouse\.?$/, 'in_transit'],
  [/^arrived at \[[^\]]{1,60}\] warehouse, sorting in progress\.?$/, 'in_transit'],
  [/^package leaves processing center \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  // The export's clearance at the origin, not the destination's customs.
  [/^export customs\/release \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^express delivery arrives at the international processing center \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^the shipment leaves the international processing center \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^handed over to the carrier for transportation \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  [/^departure international airport\.?$/, 'in_transit'],
  [/^in air transportation\.?$/, 'in_transit'],
  [/^arrive at airport \[[^\]]{1,60}\]\.?$/, 'in_transit'],
  // The air freight taken off its pallet at the destination airport, then held for the import's inspection.
  [/^during the panel removal process\.?$/, 'in_transit'],
  [/^the panel has been removed and is awaiting customs inspection\.?$/, 'customs'],
  [/^customs clearance is in progress\.?$/, 'customs'],
  [/^inspection documents are being submitted\.?$/, 'customs'],
  [/^the customs clearance is in good condition\.?$/, 'customs'],
  [/^clearance in the destination country has been completed\.?$/, 'in_transit'],
];

/** The stage JETSPEED's map gives a row, by its `normalizeStatusWording` wording. */
export function jetspeedStage(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/**
 * A row's stage: the map's, else the shared rules' without a fallback stage, as on Quick Fort's tracker, so a row the
 * map does not know yet still shows the parcel moving.
 */
export function jetspeedRowStage(wording: string): ClassifiedWording | null {
  const mapped = jetspeedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const staged = classifyWording(wording, 'in_transit');
  return staged.source === 'none' ? null : staged;
}

/** The map reads a row's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => jetspeedStage(wording), gaps: [] };
