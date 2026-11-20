import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Poșta Moldovei's scan wordings, mapped whole. The tracker words a scan in English or in
 * Romanian, with or without diacritics, and relays the scans of the post that sent the item in
 * UPU's English; the suffix marks outbound (Otb) or inbound (Inb) handling. The replies carry no
 * event code, so the wording sets the stage.
 */
export const POSTA_MOLDOVEI_EVENTS: Readonly<Record<string, Stage>> = {
  'Receive item from customer (Otb)': 'accepted',
  'Posting/collection': 'accepted',
  'Recepţionarea de la client': 'accepted',
  'Receptionare de la client': 'accepted',
  'Send item to domestic location (Otb)': 'in_transit',
  'Receive item at office of exchange (Otb)': 'in_transit',
  'Insert item into bag (Otb)': 'in_transit',
  'Insert item into bag': 'in_transit',
  'Arrival at outward Office of Exchange': 'in_transit',
  'Sosirea la biroul de schimb de expediere': 'in_transit',
  'Send item abroad (EDI-received)': 'in_transit',
  'Expedierea spre tara de destinatie': 'in_transit',
  'Expedierea trimiterii in strainatate': 'in_transit',
  'Receive item at office of exchange (Inb)': 'in_transit',
  'Arrival at inward Office of Exchange': 'in_transit',
  'Parvenirea la biroul de schimb de destinaţie': 'in_transit',
  'Parvenirea la biroul de schimb de destinatie': 'in_transit',
  // Presented to customs at the office of exchange, then back from it.
  'Trimitere prezentată organelor vamale de import': 'customs',
  'Item presented to import customs': 'customs',
  'Prezentarea la vamă': 'customs',
  'Predarea trimiterii la vama': 'customs',
  'Record item customs information (Inb)': 'customs',
  'Return item from customs (Inb)': 'in_transit',
  'Întoarcerea de la vamă': 'in_transit',
  'Departure from inward Office of Exchange': 'in_transit',
  'Send item to domestic location (Inb)': 'in_transit',
  'Expedierea spre biroul de destinaţie': 'in_transit',
  'Receive item at delivery office (Inb)': 'in_transit',
  'Sosirea la oficiul de livrare': 'in_transit',
  'Sosirea în oficiul de distribuire': 'in_transit',
  'Unsuccessful item delivery attempt (Inb)': 'failed_attempt',
  'Livrarea nereuşită': 'failed_attempt',
  'Deliver item (Inb)': 'delivered',
  // Domestic items: the delivery is recorded at the office, at the second of its arrival scan.
  'Send item to domestic location': 'in_transit',
  'Arrival at delivery office': 'in_transit',
  'Record Final Delivery': 'delivered',
};

const EVENTS = new Map(Object.entries(POSTA_MOLDOVEI_EVENTS).map(([wording, stage]) => [normalizeStatusWording(wording), stage]));

/** The stage the map gives a scan's wording, if it knows it. */
export function postaMoldoveiEventStage(wording: string): Stage | undefined {
  return EVENTS.get(normalizeStatusWording(wording));
}

/** A scan's stage from its wording, else the shared wording rules, else nothing, which keeps it visible for review. */
export function postaMoldoveiStage(wording: string): ClassifiedWording | null {
  const mapped = postaMoldoveiEventStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The wording sets the stage; the replies carry no code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => postaMoldoveiEventStage(wording),
  gaps: [],
};
