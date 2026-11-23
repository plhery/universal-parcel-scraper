import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each step by its Cargo-IMP code and explains the codes only in a German
// legend, the same on its English page; the wordings are the codes' meanings in English.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage }]));

export const cargologicStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage;
export const cargologicWording = (code: string): string | undefined => ENTRIES.get(code)?.wording;

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? cargologicStage(code) : undefined),
  gaps: [],
};
