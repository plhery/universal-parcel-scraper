import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's internal states (`ifowState`) with the stage each one means: the seller prepares
 * the order, iFLOW collects it, unloads it at its distribution centre, receives it into the
 * delivery circuit and sends it on to the branch nearest the recipient. A state the map does not
 * know stays unstaged, and its customer wording goes to the shared rules.
 */
const STATES: ReadonlyMap<string, Stage> = new Map<string, Stage>([
  ['registrado', 'registered'],
  ['retirado', 'accepted'],
  ['descargado', 'in_transit'],
  ['recibido en cd', 'in_transit'],
  ['despachado a nodo interno', 'in_transit'],
]);

const folded = (code: string): string => code.toLocaleLowerCase('es').trim().split(/\s+/).join(' ');

/** The stage of an internal state, whatever its case and spacing. */
export function iflowStage(code: string): Stage | undefined {
  return STATES.get(folded(code));
}

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? iflowStage(code) : undefined), gaps: [] };
