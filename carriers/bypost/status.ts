import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/** One code of the tracker: the wording its page shows, and its stage. */
interface BypostCode {
  readonly wording: string;
  readonly stage?: Stage;
}

// The page's own tables: a shipment's status, then a package event's code. The two
// share IN_TRANSIT and DELIVERED, with one wording and one stage each.
const CODES: ReadonlyMap<string, BypostCode> = new Map<string, BypostCode>([
  ['PREPARING', { wording: 'Klargjøres', stage: 'registered' }],
  ['EXCEPTION', { wording: 'Avvik', stage: 'exception' }],
  ['CANCELLED', { wording: 'Kansellert', stage: 'exception' }],
  ['HANDED_IN', { wording: 'Levert til transportør', stage: 'accepted' }],
  ['AT_TERMINAL', { wording: 'På terminal', stage: 'in_transit' }],
  ['IN_TRANSIT', { wording: 'Underveis', stage: 'in_transit' }],
  ['IN_INTERNATIONAL_TRANSIT', { wording: 'I internasjonal transport', stage: 'in_transit' }],
  ['IN_CUSTOMS', { wording: 'Til tollbehandling', stage: 'customs' }],
  ['READY_FOR_PICKUP', { wording: 'Klar for henting', stage: 'ready_for_pickup' }],
  ['OUT_FOR_DELIVERY', { wording: 'Ut for levering', stage: 'out_for_delivery' }],
  ['DELIVERY_ATTEMPTED', { wording: 'Leveringsforsøk', stage: 'failed_attempt' }],
  ['DELIVERED', { wording: 'Levert', stage: 'delivered' }],
  ['RETURNING_TO_SENDER', { wording: 'På vei tilbake til avsender', stage: 'exception' }],
  ['RETURNED_TO_SENDER', { wording: 'Returnert til avsender', stage: 'returned' }],
  ['DELAYED', { wording: 'Mulig forsinkelse' }],
  ['DELIVERY_RESCHEDULED', { wording: 'Leveringsdato endret' }],
  ['HOME_DELIVERY_ORDERED', { wording: 'Hjemlevering bestilt' }],
  ['HOME_DELIVERY_CANCELLED', { wording: 'Hjemlevering kansellert' }],
]);

/** What the page tells the recipient under a shipment's status. */
export const SHIPMENT_NOTES: Readonly<Record<string, string>> = {
  PREPARING: 'Sendingen er registrert og gjøres klar for transport.',
  IN_TRANSIT: 'Sendingen er på vei.',
  DELIVERED: 'Sendingen er levert.',
  EXCEPTION: 'Det er et avvik på sendingen. Ta kontakt om du lurer på noe.',
  CANCELLED: 'Sendingen er kansellert.',
};

/** A code's wording and stage, or undefined for a code the tracker's page does not list. */
export function bypostCode(code: string): BypostCode | undefined {
  return CODES.get(code);
}

const NOTICE = 'A notice about the delivery; the parcel stays where its last scan left it.';

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code)?.stage : undefined),
  gaps: [
    { code: 'DELAYED', note: NOTICE },
    { code: 'DELIVERY_RESCHEDULED', note: NOTICE },
    { code: 'HOME_DELIVERY_ORDERED', note: NOTICE },
    { code: 'HOME_DELIVERY_CANCELLED', note: NOTICE },
  ],
};
