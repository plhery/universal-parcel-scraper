import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

export const ENTRIES: readonly { readonly code?: string; readonly wording: string; readonly stage: string }[] = statuses.entries;
const WORDINGS = new Map<string, Stage>(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The platform's scripted flight row names the airport by its code: `SZX, FLIGHT DEPARTED`.
const DEPARTED = /^[a-z]{3}, flight departed$/;

/**
 * The stage YouBang Express's map gives a row, by its `normalizeStatusWording` wording; the scripted
 * flight row reads the same whatever its airport. A row's kind code groups many wordings and decides nothing.
 */
export function youbangExpressStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? (DEPARTED.test(wording) ? 'in_transit' : undefined);
}

export const statusMap: CarrierStatusMap = { stage: youbangExpressStage, gaps: [] };
