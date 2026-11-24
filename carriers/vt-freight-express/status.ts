import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * VT Freight Express's scan wordings, which come without codes. Only wordings
 * seen on the tracker are mapped; another falls to the shared wording rules.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map([
  [normalizeStatusWording('Depot In'), 'in_transit'],
  // Loaded on a truck. The consignment software has its own "On Delivery" for the delivery run.
  [normalizeStatusWording('On Board'), 'in_transit'],
  [normalizeStatusWording('Delivered'), 'delivered'],
]);

/** The stage VT Freight Express's map gives a wording in `normalizeStatusWording` form. */
export function vtFreightExpressMappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(wording);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function vtFreightExpressStage(wording: string): ClassifiedWording | null {
  const mapped = vtFreightExpressMappedStage(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Every wording seen is mapped. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => vtFreightExpressMappedStage(wording),
  gaps: [],
};
