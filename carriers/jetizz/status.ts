import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { arasStage } from '../aras-kargo/status.js';
import entries from './statuses.json' with { type: 'json' };

// The wordings seen on the tracker: Jetizz's current status and movements, and the partner's scans.
const WORDING = new Map(entries.entries.filter(entry => entry.stage)
  .map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const STAGELESS = new Set(entries.entries.filter(entry => !entry.stage).map(entry => normalizeStatusWording(entry.wording)));

// The partner's scans not seen here yet read as Aras Kargo reads them.
function stageOf(wording: string): Stage | undefined {
  return STAGELESS.has(wording) ? undefined : WORDING.get(wording) ?? arasStage(wording);
}

/** The stage of a status or a scan by the tracker's map, else by the wording itself; none for a stageless wording. */
export function jetizzStage(description: string): ClassifiedWording | null {
  const wording = normalizeStatusWording(description);
  if (STAGELESS.has(wording)) return null;
  const stage = stageOf(wording);
  if (stage) return { stage, source: 'carrier_map' };
  const classified = classifyWording(description, 'in_transit');
  return classified.source === 'none' ? null : classified;
}

/** The tracker's movements and scans carry wording and no code. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => code ? undefined : stageOf(wording),
  gaps: [],
};
