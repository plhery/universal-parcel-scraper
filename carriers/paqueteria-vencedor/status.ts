import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function vencedorStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => vencedorStage(wording), gaps: [] };
