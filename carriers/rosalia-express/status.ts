import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function rosaliaStage(code: string | null | undefined, wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording)) ?? (code ? stages.get(normalizeStatusWording(code)) : undefined);
}

export const statusMap: CarrierStatusMap = { stage: rosaliaStage, gaps: [] };
