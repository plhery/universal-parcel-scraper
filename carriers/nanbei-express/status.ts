import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Each of Nanbei's rows carries an event code (`eventNode`) beside the event's name and a sentence.
 * The codes recorded in `statuses.json` carry one stage whatever the sentence, so the map reads the
 * code alone.
 */
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** A row's stage by its code in the map, else by the shared wording rules on its name, then its sentence. */
export function nanbeiStage(code: string, name: string, sentence: string): ClassifiedWording | null {
  const stage = CODED.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  for (const wording of [name, sentence]) {
    const worded = wording ? classifyWording(wording, 'in_transit') : null;
    if (worded && worded.source !== 'none') return worded;
  }
  return null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code) : undefined),
  gaps: [],
};
