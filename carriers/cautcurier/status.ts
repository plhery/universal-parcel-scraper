import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { readonly code?: string; readonly wording: string; readonly stage?: string }
const ENTRIES: readonly Entry[] = statuses.entries;

/** The stages of the order and event types the tracker's reply carries, as recorded in `statuses.json`. */
const CODES: ReadonlyMap<string, Stage> = new Map(ENTRIES.filter(entry => entry.code && entry.stage)
  .map(entry => [entry.code!, entry.stage as Stage]));

/** The English label the tracking page shows for each type, from its bundle. */
const LABELS: ReadonlyMap<string, string> = new Map(ENTRIES.filter(entry => entry.code).map(entry => [entry.code!, entry.wording]));

export function cautCurierStage(type: string): Stage | undefined {
  return CODES.get(type);
}

export function cautCurierLabel(type: string): string | undefined {
  return LABELS.get(type);
}

export const statusMap: CarrierStatusMap = { stage: code => (code ? CODES.get(code) : undefined), gaps: [] };
