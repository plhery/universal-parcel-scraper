import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { laPosteBurkinaFasoEventStage } from '../la-poste-burkina-faso/status.js';

/**
 * The IPS event names Correos Panamá prints in Spanish for its own scans,
 * with their leg, and an English one La Poste Burkina Faso's map lacks. Its
 * other scans, and the destination posts', keep the UPU's English names,
 * which that map reads.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['recibe elemento de cliente', 'accepted'],
  ['recibir el artículo en la oficina de cambio', 'in_transit'],
  ['enviado a destino', 'in_transit'],
  ['send item out of sorting centre', 'in_transit'],
]);

// The leg a name ends with.
const LEG = /\s*\((?:otb|inb|edi-received)\)$/;

/** The stage the map gives a scan's event name, if it knows it. */
export function correosPanamaEventStage(name: string): Stage | undefined {
  return NAMES.get(normalizeStatusWording(name).replace(LEG, '')) ?? laPosteBurkinaFasoEventStage(name);
}

/** A scan's stage from its event name, else the shared wording rules, else nothing, which keeps it visible for review. */
export function correosPanamaStage(name: string): ClassifiedWording | null {
  const mapped = correosPanamaEventStage(name);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(name, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The scans carry no code. A scan's wording is its event name, then the
 * details of its extra information after a colon; the event name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : correosPanamaEventStage(wording.split(': ')[0]!)),
  gaps: [],
};
