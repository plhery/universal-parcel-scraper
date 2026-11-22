import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

/**
 * A row without a status of its own records a hand-off inside Jamaica Post, to
 * the next location it names, which the adapter writes under the page's
 * heading "Next Location". Statuses the page prints in its own column are kept
 * without a stage until one is seen.
 */
const NAMES: ReadonlyMap<string, Stage> = new Map([
  ['next location', 'in_transit'],
]);

/** The stage the map gives a row's wording, if it knows it. */
export function jamaicaPostStage(name: string): Stage | undefined {
  return NAMES.get(normalizeStatusWording(name));
}

/**
 * The rows carry no code. A row's wording is its status, or "Next Location",
 * then the next location after a colon; the part before the colon sets the stage.
 */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? undefined : jamaicaPostStage(wording.split(': ')[0]!)),
  gaps: [],
};
