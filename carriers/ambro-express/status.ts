import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map<string, Stage>(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function stageForScan(wording: string): Stage | undefined {
  return stages.get(normalizeStatusWording(wording));
}
