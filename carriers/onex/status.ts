import { classifyWording, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The import and export dates carry the page's own codes, since both name a step "Received";
// the event list carries wordings only.
const CODES = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? [[entry.code, entry.stage as Stage] as const] : []));
const WORDINGS = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? []
  : [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const]));
/** The caption the page gives each import or export date, by its code. */
export const MILESTONES = new Map(statuses.entries.flatMap(entry => 'code' in entry && entry.code ? [[entry.code, entry.wording] as const] : []));

/** The stage of a date by its code, else of an event by its wording, else by shared wording rules. */
export function onexStage(code: string | undefined, wording: string): ClassifiedWording | null {
  const mapped = code ? CODES.get(code) : WORDINGS.get(normalizeStatusWording(wording));
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (code) return null;
  const shared = classifyWording(wording, 'in_transit');
  return shared.source === 'none' ? null : shared;
}

export const statusMap: CarrierStatusMap = {
  stage: (code, wording) => (code ? CODES.get(code) : WORDINGS.get(wording)),
  gaps: [],
};
