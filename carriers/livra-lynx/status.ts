import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map(statuses.entries.map(({ code, wording, stage }) => [code, { wording, stage: stage as Stage }]));
const byWording = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function livraStatus(code: string): { wording: string; stage: Stage } | undefined {
  return byCode.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? livraStatus(code)?.stage : undefined) ?? byWording.get(normalizeStatusWording(wording)),
  gaps: [],
  wholeWording: true,
};
