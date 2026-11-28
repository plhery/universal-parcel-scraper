import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Each of Caifeng's rows carries the operation that wrote it (`type`, as 托运开单 or 短驳) beside its
 * sentence. The operations recorded in `statuses.json` carry one stage whatever the sentence, so
 * the map reads the operation alone.
 */
const CODED: ReadonlyMap<string, Stage> = new Map(statuses.entries.map((entry) => [entry.code, entry.stage as Stage]));

/** A row's stage by its operation in the map, else by the shared wording rules on its sentence. */
export function caifengStage(code: string, sentence: string): ClassifiedWording | null {
  const stage = CODED.get(code);
  if (stage) return { stage, source: 'carrier_map' };
  const worded = sentence ? classifyWording(sentence, 'in_transit') : null;
  return worded && worded.source !== 'none' ? worded : null;
}

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODED.get(code) : undefined),
  gaps: [],
};
