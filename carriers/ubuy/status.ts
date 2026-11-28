/**
 * UBUYLOGI's rows: a text without a code, in Chinese: the warehouse's own, the customs broker's and SF Express's,
 * which the page copies. An entry of `statuses.json` records a text with the waybill it names as … and the places
 * SF Express names in brackets as 【…】; a text the map does not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * A text as `statuses.json` records it: the waybill after 单号 as …, each place in brackets but the warehouse's
 * as 【…】, and the city SF Express names after 途经 as ….
 */
export function ubuyWording(description: string): string {
  return normalizeStatusWording(description.replace(/(单号\s*)[A-Za-z0-9]{8,30}/gu, '$1…')
    .replace(/【(?!德国仓】)[^】]*】/gu, '【…】').replace(/^(快件途经)\p{Script=Han}{1,20}$/u, '$1…'));
}

const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [ubuyWording(entry.wording), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => STAGES.get(ubuyWording(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function ubuyStage(description: string): ClassifiedWording | null {
  const stage = STAGES.get(ubuyWording(description));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
