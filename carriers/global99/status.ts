/**
 * Global Courier International's rows: a text without a code, its own or one the courier in China
 * wrote. An entry of `statuses.json` records a text with each bracket as 【…】, the courier's number
 * as …, and the stations a domestic courier's row names as …; a text the map does not know goes
 * through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The form a text is listed under, from its `normalizeStatusWording` form. */
export function global99Template(wording: string): string {
  return wording.replace(/【[^】]*】/gu, '【…】')
    .replace(/单号\s*[:：]\s*[a-z0-9]+/gu, '单号：…')
    .replace(/^(【…】 快件已(?:到达|发往)) .+$/u, '$1 …')
    .replace(/^货物 在 .+ 装车 下一站 .+$/u, '货物 在 … 装车 下一站 …')
    .replace(/^.+ 正在为您派件$/u, '… 正在为您派件');
}

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [global99Template(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(global99Template(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function global99Stage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(global99Template(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
