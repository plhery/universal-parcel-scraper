import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const stages = new Map<string, Stage>(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

// The adapter uses this map when it reads its own history.
export const scanStages: CarrierStatusMap = {
  stage: (_code, wording) => stages.get(wording),
  gaps: [],
};
