import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The template each row is written from (`templateNode`), with its stage.
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (code) => (code ? CODED.get(code) : undefined), gaps: [] };

/** A row's stage: its template's, else the shared wording rules', or null when neither reads it. */
export function xydwlStage(code: string, wording: string): ClassifiedWording | null {
  const stage = CODED.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
