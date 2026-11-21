import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// SmartKargo words each milestone in one English word; the summary adds the station, as "Departed at DPS".
const STAGES: ReadonlyMap<string, Stage | null> = new Map(statuses.entries.map(
  entry => [normalizeStatusWording(entry.wording), entry.stage as Stage | null],
));

export function stageForWording(wording: string): Stage | undefined {
  return STAGES.get(normalizeStatusWording(wording.replace(/ at [A-Z]{3}$/i, ''))) ?? undefined;
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stageForWording(wording),
  gaps: [],
  wholeWording: true,
};
