import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

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
];

/** The stage JETSPEED's map gives a row, by its `normalizeStatusWording` wording. */
export function jetspeedStage(wording: string): Stage | undefined {
  return WORDINGS.find(([pattern]) => pattern.test(wording))?.[1];
}

/** The map reads a row's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => jetspeedStage(wording), gaps: [] };
