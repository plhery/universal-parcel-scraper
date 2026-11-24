import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker's status column, and the status joined with a remark the adapter keeps, by wording.
const BY_WORDING: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// "Zustellhindernis: Kunde nicht angetroffen": the status, a colon and the remark.
const REMARKED = /^([^:]{1,60}): .{1,120}$/;

/** The stage of a row's wording: the whole wording, else its status before the remark. */
export function derKurierMappedStage(wording: string): Stage | undefined {
  const key = normalizeStatusWording(wording);
  const status = REMARKED.exec(key)?.[1];
  return BY_WORDING.get(key) ?? (status ? BY_WORDING.get(status) : undefined);
}

/** A row's stage: the map, else the shared German rules, else nothing. */
export function derKurierStage(wording: string): ClassifiedWording | null {
  const mapped = derKurierMappedStage(wording);
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/** The tracker's rows carry wording without codes. */
export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (code, wording) => (code ? undefined : derKurierMappedStage(wording)),
  gaps: [],
};
