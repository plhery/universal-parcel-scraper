import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(({ wording, stage }) => [
  normalizeStatusWording(wording), stage as Stage | null,
]));

export function scanStage(wording: string): Stage | null {
  return stages.get(normalizeStatusWording(wording)) ?? null;
}
