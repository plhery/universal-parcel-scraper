import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import { yweMappedStage } from '../ywe/status.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly wording: string; readonly stage: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/**
 * YWBZ's scans are English wording, its own steps in Yiwu and its export
 * centre, the air line's and the delivering network's. Codes are few and
 * follow no one scheme, so the map is the wording recorded in
 * `statuses.json`.
 */
const WORDINGS: ReadonlyMap<string, Stage> = new Map(ENTRIES.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The line handed the parcel to a different last-mile carrier.
const NEW_VENDOR = /^the warehouse changed the last-mile vendor due to the weight difference, the new tracking number is [a-z0-9]{4,40}$/;

function mappedStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  const mapped = WORDINGS.get(normalized);
  if (mapped) return mapped;
  if (NEW_VENDOR.test(normalized)) return 'in_transit';
  // YWE's hub receipt after the handover. The suffix is its depot code.
  return normalized.startsWith('parcel received by in ') ? yweMappedStage(normalized) : undefined;
}

/** A scan's stage: the map, else the shared wording rules, else nothing. */
export function ywbzStage(wording: string): ClassifiedWording | null {
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
