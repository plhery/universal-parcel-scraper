import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const statusByCode = new Map<string, { stage: Stage; wording: string }>(
  statuses.entries.map(entry => [entry.code.toLowerCase(), { stage: entry.stage as Stage, wording: entry.wording }]),
);

export function statusForCode(code: string) {
  return statusByCode.get(code.toLowerCase());
}
