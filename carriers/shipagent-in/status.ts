import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The rows seen, by their wording, and ShipAgent's own status codes, by code.
const WORDINGS = new Map<string, Stage>(statuses.entries.filter((entry) => !('code' in entry))
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const CODES = new Map<string, Stage>(statuses.entries.flatMap((entry) => ('code' in entry && typeof entry.code === 'string'
  ? [[entry.code, entry.stage as Stage] as const] : [])));

/**
 * A row's stage: its wording when the map knows it, else ShipAgent's code for the row. The
 * wording is the finer: ShipAgent files a customs inspection or a held parcel as in transit or unknown.
 */
export function shipAgentStage(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? (code ? CODES.get(code) : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: shipAgentStage,
  gaps: [],
};
