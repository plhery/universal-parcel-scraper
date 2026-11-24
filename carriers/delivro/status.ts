import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * Délivro's checkpoints as its Dispatch Science tracker words them: in English when asked in
 * English, in French otherwise. A checkpoint's own status code is the order's status when it was
 * written, not what the checkpoint says: a hold keeps "picked up", so the wording alone stages it.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  ['order information received', 'registered'],
  ['informations de la commande reçues', 'registered'],
  ['order picked up', 'accepted'],
  ['commande récupérée', 'accepted'],
  ['order put on hold', 'exception'],
  ['commande mise en attente', 'exception'],
  ['order released', 'in_transit'],
  ['commande débloquée', 'in_transit'],
  ['order delivered', 'delivered'],
  ['commande livrée', 'delivered'],
]);

/**
 * The order's status, Dispatch Science's order status enum as the tracking page's script names it,
 * with the label of the page's progress rail where it has one. The rail counts "en route" as past
 * the pickup without naming it, and says nothing of a delivery round, so it is in transit.
 */
const ORDER: ReadonlyMap<string, { stage: Stage; label: string }> = new Map([
  ['0', { stage: 'registered', label: 'Received' }],
  ['1', { stage: 'registered', label: 'Assigned' }],
  ['2', { stage: 'accepted', label: 'Picked Up' }],
  ['3', { stage: 'in_transit', label: 'En Route' }],
  ['4', { stage: 'delivered', label: 'Delivered' }],
  ['91', { stage: 'exception', label: 'Cancelled' }],
]);

/** The stage Délivro's map gives a checkpoint's wording, if it knows it. */
export function delivroMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}

/** The stage and the page's label for an order status code. */
export function delivroOrder(code: string): { stage: Stage; label: string } | undefined {
  return ORDER.get(code);
}

/**
 * A checkpoint's stage from the map, else a hold the tracker flags as an interruption, else the
 * shared wording rules. Wording none of them knows stays without a stage, open for review.
 */
export function delivroStage(wording: string, interruption: boolean): ClassifiedWording | null {
  const mapped = delivroMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (interruption) return { stage: 'exception', source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Checkpoints carry wording only; the order's status code stands for an order without checkpoints. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? delivroOrder(code)?.stage : delivroMappedStage(wording)),
  gaps: [],
  wholeWording: true,
};
