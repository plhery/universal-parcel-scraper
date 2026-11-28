/**
 * 1688 International Logistics' rows: a text without a code, each in the platform's own words. An entry of
 * `statuses.json` records a text with each bracket as 【…】 and each long run of digits as #; a text the map does
 * not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The form a text is listed under, from its `normalizeStatusWording` form. */
export function buyer1688Template(wording: string): string {
  return wording.replace(/【[^【】]*】/gu, '【…】').replace(/\d{6,}/gu, '#');
}

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [buyer1688Template(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(buyer1688Template(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function buyer1688Stage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(buyer1688Template(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
