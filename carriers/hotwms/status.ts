/**
 * HOTWMS's steps: fixed wordings, without a code. The hand-over to the last leg names that
 * carrier and its number after the wording, so the map reads it without either. Anything
 * `statuses.json` does not record goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// "已交付末段 [EMS]: …": the wording, without the carrier's name and number.
const LAST_LEG = /^(已交付末段)\s*[[【][^\]】]{1,40}[\]】]\s*[:：]?\s*[a-z0-9]{0,40}$/u;
const key = (wording: string) => normalizeStatusWording(wording).replace(LAST_LEG, '$1');
const MAPPED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [key(entry.wording), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = { stage: (_code, wording) => MAPPED.get(key(wording)), gaps: [] };

/** A step's stage, by its wording, else by the shared wording rules, or none. */
export function hotwmsStage(wording: string): ClassifiedWording | null {
  const stage = MAPPED.get(key(wording));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}
