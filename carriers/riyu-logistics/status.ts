import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the state codes of Riyu's route rows, as recorded in `statuses.json`. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.code && entry.stage)
  .map(entry => [entry.code!, entry.stage as Stage]));

export function riyuStage(code: string): Stage | undefined {
  return CODES.get(code);
}

export const statusMap: CarrierStatusMap = { stage: code => (code ? CODES.get(code) : undefined), gaps: [] };
