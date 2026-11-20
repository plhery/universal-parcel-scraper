import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
export function hellmannStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(wording)), gaps: [
  { wording: normalizeStatusWording('OPEN'), note: 'An open road record does not confirm physical collection.' },
  { wording: normalizeStatusWording('ON_SCHEDULE'), note: 'Schedule compliance alone does not establish a physical milestone.' },
  { wording: normalizeStatusWording('IN_DELIVERY'), note: 'The public summary needs a separately verified delivery-round meaning.' },
  { wording: normalizeStatusWording('IN_CLARIFICATION'), note: 'Clarification alone does not establish a physical exception.' },
] };
