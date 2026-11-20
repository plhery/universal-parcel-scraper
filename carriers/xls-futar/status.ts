import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
export function xlsFutarStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(wording)), gaps: [
  { wording: normalizeStatusWording('Depó'), note: 'The public depot summary supplies no history to distinguish intake from a later hub.' },
  { wording: normalizeStatusWording('Lezárva'), note: 'A closed record does not by itself assert delivery.' },
] };
