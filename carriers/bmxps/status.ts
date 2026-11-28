/**
 * BMXPS's rows: a text without a code, which names the Baltimore warehouse or SF Express's branch in brackets.
 * An entry of `statuses.json` records a text with each place as 【…】 and the courier's waybill in a hand-off as
 * an ellipsis; a text the map does not know goes through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The form a text is listed under: each bracketed place as 【…】, the hand-off waybill as an ellipsis. */
const template = (wording: string): string => wording.replace(/【[^】]*】/gu, '【…】')
  .replace(/(运单号\s*[:：]?\s*)[a-z0-9]{8,30}/giu, '$1…');

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [template(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(template(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function bmxpsStage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(template(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
