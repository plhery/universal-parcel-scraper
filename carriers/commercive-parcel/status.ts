import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The scans' wordings seen, by wording, and the parcel's status codes, by code.
const WORDINGS = new Map<string, Stage>(statuses.entries.filter((entry) => typeof entry.wording === 'string')
  .map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
const CODES = new Map<string, Stage>(statuses.entries.flatMap((entry) => ('code' in entry && typeof entry.code === 'string'
  ? [[entry.code, entry.stage as Stage] as const] : [])));

/** A scan's or the parcel's stage: its wording when the map knows it, else the parcel's status code. */
export function commerciveStage(code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording)) ?? (code ? CODES.get(code) : undefined);
}

export const statusMap: CarrierStatusMap = {
  stage: commerciveStage,
  gaps: [],
};
