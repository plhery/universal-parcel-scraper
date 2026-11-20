import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const entries = new Map(statuses.entries.map(({ code, wording, stage }) => [code, { wording, stage: stage as Stage | null }]));
const wordings = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage | null]));

export function bssStatus(code: string) {
  return entries.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code && bssStatus(code)?.stage) || wordings.get(normalizeStatusWording(wording)) || undefined,
  gaps: [],
};
