import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The status texts Quick Track was seen to give, whole, with the stage each means.
const WORDED: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// "Scanned in BRISBANE Depot": a depot's scan, whichever depot.
const DEPOT_SCAN = /^scanned in (.+) depot$/;

/** The depot a status text names, as the text gives it. */
export function airroadDepot(wording: string): string | undefined {
  return /^Scanned in (.+) Depot$/i.exec(wording.trim())?.[1]?.trim() || undefined;
}

function mapped(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  return WORDED.get(key) ?? (DEPOT_SCAN.test(key) ? 'in_transit' : undefined);
}

/** A status text's stage from the map, else the shared rules on it, else nothing, which keeps it visible for review. */
export function airroadStage(wording: string): ClassifiedWording | null {
  const stage = mapped(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** Quick Track gives no codes: its status text sets the stage. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => mapped(wording),
  gaps: [],
};
