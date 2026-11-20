import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map(statuses.entries.map(entry => [entry.code, { wording: entry.wording, stage: entry.stage as Stage }]));
const byWording = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function alhosaryStatus(code: string): { wording: string; stage: Stage } | undefined {
  return byCode.get(code);
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? alhosaryStatus(code)?.stage : undefined) ?? byWording.get(normalizeStatusWording(wording)),
  gaps: [],
};
