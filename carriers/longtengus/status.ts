import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Longteng's rows carry Chinese wording without codes, from the waybill's creation in Portland to the
 * hand-off to a courier in China. The hand-off row ends with the courier's number, which becomes an
 * ellipsis. The map is the wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// "单号：77122221658027": the number the row ends with.
const NUMBER = /(单号\s*[：:]\s*)[a-z0-9]{8,30}$/;

function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording).replace(NUMBER, '$1…'));
}

/** A row's stage: the map, else the shared wording rules, else nothing. */
export function longtengStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about one row, by its wording: the page shows no codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : mappedStage(wording)),
  gaps: [],
};
