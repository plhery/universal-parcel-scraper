import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

// Who took a delivered item, after its wording: "Entregado al cliente - Recibido por:" and the person's name and cédula.
const RECEIVER = /\s+-\s*recibid[oa] por\b.*$/is;
// A run of ten digits or more, as a cédula, a RUC or a phone number is written.
const IDENTITY_DIGITS = /\d{10,}/g;

/** A scan's wording without the person who took the item or a number that could identify them. */
export function withoutReceiver(wording: string): string {
  return wording.replace(RECEIVER, '').replace(IDENTITY_DIGITS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The tracker's scan wordings, in Spanish and without codes, for Servicios
 * Postales del Ecuador's own scans and for those the sending post reported.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['envío recibido del cliente', 'accepted'],
  ['despachado a destino', 'in_transit'],
  ['paquete enviado a país destino', 'in_transit'],
  // Ecuador's office of exchange received the item from abroad.
  ['recibido ecuador- inicio procesamiento', 'in_transit'],
  // Customs released the import.
  ['salida de aduana - importación', 'in_transit'],
  ['recibido en oficina', 'in_transit'],
  ['recibido en oficina de distribución', 'in_transit'],
  ['entregado al cliente', 'delivered'],
]);

// Wordings that end in a part of their own: the office an item is sent to, the kind of a customs check.
const PREFIXES: readonly (readonly [RegExp, Stage])[] = [
  [/^despachado a oficina(?: |$)/, 'in_transit'],
  [/^proceso de revisión aduana(?: |$)/, 'customs'],
];

/** The stage the map gives a wording, if it knows it. */
export function correosEcuadorStatusStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(withoutReceiver(wording));
  return NAMES.get(key) ?? PREFIXES.find(([prefix]) => prefix.test(key))?.[1];
}

/**
 * A scan's stage from the map, else from the shared wording rules. Wording
 * neither knows stays without a stage, so it remains visible for review.
 */
export function correosEcuadorStage(wording: string): ClassifiedWording | null {
  const mapped = correosEcuadorStatusStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The scans are wording only. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : correosEcuadorStatusStage(wording)),
  gaps: [],
};
