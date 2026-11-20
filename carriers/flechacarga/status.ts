import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(row => [normalizeStatusWording(row.wording), row.stage as Stage]));
export function flechaStage(wording: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(wording));
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => flechaStage(wording), gaps: [] };
