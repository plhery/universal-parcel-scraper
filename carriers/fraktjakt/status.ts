import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map<string, Stage>(statuses.entries.map(entry => [entry.code.toLowerCase(), entry.stage as Stage]));

export function stageForWording(wording: string): Stage | undefined {
  return stages.get(wording.toLowerCase());
}
