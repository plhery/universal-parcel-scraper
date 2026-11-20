import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Navex's event wording, in `normalizeStatusWording` form, as its tracker
 * shows it. The tracker shows no codes. Other wording falls to the shared
 * rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  // The merchant created the order, which then waits for a Navex driver to collect it.
  ['commande créée', 'registered'],
  ["en attente d'enlèvement", 'registered'],
  // Received at a Navex depot, the first one or the next one on the way, and sent between depots.
  ['réceptionné au magasin', 'in_transit'],
  ['transfert inter-dépôts', 'in_transit'],
  ['en cours de livraison', 'out_for_delivery'],
  // Delivery stopped until the merchant clears up a problem with the order.
  ["à vérifier avec l'expéditeur", 'exception'],
  // Delivery given up, then the parcel prepared, sent and handed back to the merchant.
  ['retour définitif', 'returned'],
  ['en préparation pour retour', 'returned'],
  ['retour expéditeur', 'returned'],
  ['retour traité', 'returned'],
]);

/** The stage Navex's own wording gives an event. */
export function navexMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** An event's stage: Navex's wording, else the shared rules, else nothing. */
export function navexStage(wording: string): ClassifiedWording | null {
  const mapped = navexMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

export const statusMap: CarrierStatusMap = {
  // The tracker gives no codes.
  stage: (code, wording) => (code ? undefined : navexMappedStage(wording)),
  gaps: [],
};
