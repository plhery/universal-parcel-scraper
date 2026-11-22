import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * The tracker's two dated steps and the status it names. "Ingreso" is the
 * item entering Correo Paraguayo's network; "Planillado" puts it on a dispatch
 * sheet to the office in charge of it. Neither says it reached the addressee.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['ingreso', 'in_transit'],
  ['planillado', 'in_transit'],
]);

/** The stage the map gives a step or status, if it knows it. */
export function correoParaguayoStage(name: string): Stage | undefined {
  return NAMES.get(normalizeStatusWording(name));
}

/**
 * The replies carry no code. A step's wording is its name, then the office in
 * charge after a colon; the name sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : correoParaguayoStage(wording.split(': ')[0]!)),
  gaps: [],
};
