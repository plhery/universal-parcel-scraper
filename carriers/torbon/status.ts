import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * Torbon's system rows carry a code and English wording. The rows its staff type, from the container's
 * loading to the delivery at the warehouse, come in Chinese without a code and name the days they expect
 * ("预计3.15号离港"); each such day becomes an ellipsis. The map is the codes and wording recorded in
 * `statuses.json`.
 */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => entry.code)
  .map((entry) => [entry.code!, entry.stage as Stage]));
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter((entry) => !entry.code)
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// A day the staff name as month.day, "4.12号".
const DAY = /(?<![\d.])\d{1,2}\.\d{1,2}(?=号)/g;

const key = (wording: string): string => normalizeStatusWording(wording).replace(DAY, '…');

function mappedStage(code: string, wording: string): Stage | undefined {
  return (code ? CODES.get(code) : undefined) ?? WORDINGS.get(key(wording));
}

/** A scan's stage: its code, else its wording in the map, else the shared wording rules, else nothing. */
export function torbonStage(wording: string, code = ''): ClassifiedWording | null {
  const mapped = mappedStage(code, wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** What the map says about a scan, by its code, else by its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => mappedStage(code ?? '', wording),
  gaps: [],
};
