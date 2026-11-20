import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const codes = new Map<string, Stage>();
const wordings = new Map<string, Stage>();
for (const { code, wording, stage } of statuses.entries) {
  if (code) codes.set(code, stage as Stage);
  wordings.set(normalizeStatusWording(wording), stage as Stage);
}

export function astralStage(code: string | null, wording: string): Stage | undefined {
  return (code ? codes.get(code) : undefined) ?? wordings.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: astralStage, gaps: [] };
