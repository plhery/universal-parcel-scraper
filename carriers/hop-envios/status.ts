import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

export function stageForCode(code: string): Stage | undefined {
  return stages.get(code);
}
