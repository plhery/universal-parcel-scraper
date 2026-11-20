import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map<string, Stage | null>(statuses.entries.map(entry => [entry.code, entry.stage as Stage | null]));

// These states are defined by the public endpoint's schema.
stages.set('pending', 'pending');
stages.set('exception', 'exception');
stages.set('attention', 'exception');

export function stageForCode(code: string): Stage | undefined {
  return stages.get(code) ?? undefined;
}
