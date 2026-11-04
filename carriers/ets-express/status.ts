import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [
  JSON.stringify([entry.code ?? null, normalizeStatusWording(entry.wording)]), entry.stage as Stage,
]));

/** The whole wording and its kind: a Hualei kind groups unrelated milestones. */
export const etsStage = (code: string | null, wording: string): Stage | undefined => WORDINGS.get(JSON.stringify([code, wording]));

export const statusMap: CarrierStatusMap = { stage: etsStage,
  gaps: [{ code: 'CO_C_CR', note: 'Hualei custom-trajectory rows are held back as written ahead.' }],
};
