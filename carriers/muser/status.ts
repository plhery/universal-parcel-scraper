import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Muser's scans are English wording: its own steps in Hong Kong, the
 * airline's and customs', and the delivering network's. Its codes are the
 * tracker's own and absent from the delivering network's scans, so the map is
 * the wording recorded in `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The flight's departure, naming its airport.
const DEPARTURE = /^departure \[[^\]]{2,80}\]$/;

function mappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return WORDINGS.get(normalized) ?? (DEPARTURE.test(normalized) ? 'in_transit' : undefined);
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function muserStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads the scans' wording, whatever code a scan has. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mappedStage(wording),
  gaps: [],
};
