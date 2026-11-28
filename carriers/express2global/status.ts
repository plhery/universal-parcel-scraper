/**
 * E2G Express's rows: a text without a code, the firm's own. An entry of `statuses.json` records a text with the
 * courier in China and its number, between slashes at the hand-off, as …/…; a text the map does not know goes
 * through the shared wording rules.
 */
import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/** The form a text is listed under, from its `normalizeStatusWording` form. */
export function e2gTemplate(wording: string): string {
  return wording.replace(/\/[^/]{2,10}\/(?:[a-z0-9]*\d[a-z0-9]*|…)(?=$|[；;，,。\s])/gu, '/…/…');
}

const TEMPLATES: ReadonlyMap<string, Stage> = new Map(statuses.entries
  .map((entry) => [e2gTemplate(normalizeStatusWording(entry.wording)), entry.stage as Stage]));

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => TEMPLATES.get(e2gTemplate(wording)),
  gaps: [],
  wholeWording: true,
};

/** A row's stage, by its text in `statuses.json`, else by the shared wording rules, or none. */
export function e2gStage(description: string): ClassifiedWording | null {
  const stage = TEMPLATES.get(e2gTemplate(normalizeStatusWording(description)));
  if (stage) return { stage, source: 'carrier_map' };
  const worded = classifyWording(description, 'in_transit');
  return worded.source !== 'none' ? worded : null;
}
