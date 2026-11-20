import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

const eventStages = new Map<string, Stage>();
const summaries = new Map<string, { description: string; stage: Stage }>();
for (const entry of statuses.entries) {
  if (!entry.stage) continue;
  const stage = entry.stage as Stage;
  if (entry.code) summaries.set(entry.code.toLowerCase(), { description: entry.wording, stage });
  else eventStages.set(entry.wording.toLowerCase(), stage);
}

export function eventStage(wording: string): Stage | undefined {
  return eventStages.get(wording.toLowerCase());
}

export function summaryFor(code: string) {
  return summaries.get(code.toLowerCase().replace(/\s+/g, ''));
}
