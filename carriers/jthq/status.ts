import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * JTHQ's own scans, its US line's and the delivering network's come in English. Its own carry
 * codes beside the wording, and Canada Post's copies carry the tracker's codes or Canada Post's,
 * digits alone among them, so the wording decides. The map is the wording recorded in
 * `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// Canada Post's departure names its code after the wording ("Item departed 501"); USPS's round names its delivery
// window ("Out for Delivery, Expected Delivery by 9:00pm"). Each becomes an ellipsis.
const DEPARTED = /^(item departed )\d{1,4}$/;
const WINDOW = /^(out for delivery, expected delivery )(?:by \d{1,2}:\d{2}[ap]m|between \d{1,2}:\d{2}[ap]m and \d{1,2}:\d{2}[ap]m)$/;

const key = (wording: string): string => wording.replace(DEPARTED, '$1…').replace(WINDOW, '$1…');

function mappedStage(wording: string): Stage | undefined {
  return WORDINGS.get(key(normalizeStatusWording(wording)));
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function jthqStage(wording: string): ClassifiedWording | null {
  const mapped = mappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The map reads the scans' wording; a code decides nothing. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mappedStage(wording),
  gaps: [],
};
