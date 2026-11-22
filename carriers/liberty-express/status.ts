import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';

/**
 * The tracker's statuses, from the Doral warehouse to the Venezuelan branch:
 * the warehouse receives the purchase, packs it and puts it on board, the
 * local distribution center receives it, sends it on to a branch and audits
 * it, and the branch holds it for the customer to collect.
 */
const WORDINGS: readonly (readonly [RegExp, Stage])[] = [
  [/^Recibido en centro de distribuci[oó]n$/i, 'accepted'],
  [/^Empacado, listo para ser embarcado$/i, 'in_transit'],
  [/^A bordo, para ser transportado a su destino$/i, 'in_transit'],
  [/^Recibido en centro de distribuci[oó]n local$/i, 'in_transit'],
  [/^Transferido$/i, 'in_transit'],
  [/^En auditor[ií]a para entrega$/i, 'in_transit'],
  [/^Disponible para su retiro$/i, 'ready_for_pickup'],
];

/** The bill for the shipment, which says nothing about where the parcel is. */
const INVOICED = /^Facturado online$/i;

/** The stage Liberty Express's own wording gives a row. */
export function libertyMappedStage(wording: string): Stage | undefined {
  const text = wording.replace(/\s+/g, ' ').trim();
  return WORDINGS.find(([pattern]) => pattern.test(text))?.[1];
}

/** A row's stage: the carrier's own wording, else the shared wording rules; the invoice and unknown wordings get none. */
export function libertyStage(wording: string): ClassifiedWording | null {
  const mapped = libertyMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (INVOICED.test(wording.replace(/\s+/g, ' ').trim())) return null;
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The review map: the wordings above, with the invoice as an intentional gap. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => libertyMappedStage(wording),
  gaps: [{ wording: normalizeStatusWording('Facturado OnLine'), note: 'The shipment was billed; the parcel did not move.' }],
};
