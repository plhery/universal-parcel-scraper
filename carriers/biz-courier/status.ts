import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const codes = new Map<string, Stage>();
const wordings = new Map<string, Stage>();
for (const entry of statuses.entries) {
  if (!entry.stage) continue;
  if ('code' in entry && entry.code) codes.set(entry.code, entry.stage as Stage);
  else wordings.set(normalizeStatusWording(entry.wording), entry.stage as Stage);
}

export function stageForScan(code: string | null, wording: string): Stage | undefined {
  return (code ? codes.get(code) : undefined) ?? wordings.get(wording);
}

/** The map reads a scan's partner code, else its wording. */
export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => stageForScan(code, wording),
  gaps: statuses.entries.flatMap(entry => ('stage' in entry && entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note! }])),
};
