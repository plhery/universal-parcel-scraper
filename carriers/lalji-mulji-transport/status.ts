import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map<string, Stage>(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

export function stageForStatus(code: string): Stage | undefined {
  return byCode.get(code.toUpperCase());
}
