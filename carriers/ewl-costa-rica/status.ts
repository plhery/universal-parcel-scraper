import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function ewlStage(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording).normalize('NFD').replace(/\p{M}/gu, ''));
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => ewlStage(wording), gaps: [], wholeWording: true };
