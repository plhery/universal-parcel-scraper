import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Typed, since the list can be empty.
export const ENTRIES: readonly { readonly wording: string; readonly stage: string }[] = statuses.entries;
const WORDINGS = new Map<string, Stage>(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The place Pengyou writes after a row's wording, in brackets: "[Shenzhen City]".
const PLACE_TAIL = / \[[^\]]+\]$/;

/**
 * The stage Pengyou's map gives a row, by its `normalizeStatusWording` wording,
 * read without the place in brackets after it. A row's kind code, when it has
 * one, groups many wordings and decides nothing.
 */
export function pengyouStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? WORDINGS.get(wording.replace(PLACE_TAIL, ''));
}

export const statusMap: CarrierStatusMap = { stage: pengyouStage, gaps: [] };
