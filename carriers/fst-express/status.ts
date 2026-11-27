import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The code FST files Australia Post's scans under, each in Australia Post's own wording. */
export const RELAYED_CODE = 'O1';

// FST's own scan codes, each with one meaning: the scans it records and its page's progress rail.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code !== RELAYED_CODE).map((entry) => [entry.code, entry.stage as Stage]));
// Australia Post's wordings as FST relays them, by `normalizeStatusWording` form.
const RELAYED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .filter((entry) => entry.code === RELAYED_CODE).map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

/** The stage FST's map gives a scan's code, or its wording when FST relays it under `O1`. */
export function fstMappedStage(code: string | null, wording: string): Stage | undefined {
  if (code === RELAYED_CODE) return RELAYED.get(normalizeStatusWording(wording));
  return code ? CODED.get(code) : undefined;
}

/**
 * A scan's stage: the map's, else the shared rules' for its wording, else nothing. The page's
 * legend gives OD and POK one step for sorting and delivery, and AR one with OK for a delivery
 * or a failed one, so their wording decides.
 */
export function fstStage(code: string, wording: string): ClassifiedWording | null {
  const mapped = fstMappedStage(code || null, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = wording ? classifyWording(wording, 'in_transit') : null;
  return worded && worded.source !== 'none' ? worded : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => fstMappedStage(code, wording),
  gaps: [],
};
