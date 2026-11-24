import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Locate2u's item statuses the tracker was seen to give, with the stage each means and the wording
// the tracker's script shows for it.
const CODED: ReadonlyMap<string, { stage: Stage; wording: string }> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.code), { stage: entry.stage as Stage, wording: entry.wording }]));
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage the map gives a status, if it knows it. */
export function codexpressCodeStage(code: string): Stage | undefined {
  return CODED.get(normalizeStatusWording(code))?.stage;
}

/** The wording the tracker's script shows for a status; a status it does not word is shown as it comes. */
export function codexpressWording(code: string): string {
  return CODED.get(normalizeStatusWording(code))?.wording ?? code;
}

/** A status's stage from the map, else the shared rules on the status, else nothing, which keeps it visible for review. */
export function codexpressStage(code: string): ClassifiedWording | null {
  const mapped = codexpressCodeStage(code);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(code, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The status, kept as the scan's code, sets its stage; a copy without the code is read by the tracker's wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? codexpressCodeStage(code) : WORDED.get(wording)),
  gaps: [],
};
