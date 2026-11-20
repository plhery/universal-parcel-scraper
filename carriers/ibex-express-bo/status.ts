import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function ibexStage(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording)
    .replace(/\s+de [a-z]{3} a [a-z]{3}$/, '')
    .replace(/^(carga arribada a destino) en [a-z]{3}$/, '$1');
  return stages.get(normalized);
}

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => ibexStage(wording), gaps: [] };
