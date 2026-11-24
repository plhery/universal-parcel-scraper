import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The order page's steps, by the key its reply names each with. Two keys share the wording
// "Chargement" and two "Livraison", so a step is staged by its key alone.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));
// The page's own French label for each key.
const LABELS: ReadonlyMap<string, string> = new Map(statuses.entries.map((entry) => [entry.code, entry.wording]));

/** A step's stage by its key, or nothing for a key the page did not have. */
export function truskStage(code: string): Stage | undefined {
  return CODED.get(code);
}

/** The label the order page shows for a step, or undefined for a key it does not name. */
export function truskLabel(code: string): string | undefined {
  return LABELS.get(code);
}

/** Every step has a key; its label alone does not tell the steps apart. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code === null ? undefined : CODED.get(code)),
  gaps: [],
};
