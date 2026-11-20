import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };
const WORDINGS = new Map(statuses.entries.map(row => [normalizeStatusWording(row.wording), row.stage as Stage]));
export function thabitStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(wording)), gaps: [
  ...['First delivery attempt', 'Second delivery attempt', 'Third delivery attempt', 'First pickup attempt'].map(wording => ({
    wording: normalizeStatusWording(wording), note: 'An attempt counter supplies no completed pickup or failed delivery outcome.' })),
  { wording: normalizeStatusWording('Assigned to courier'), note: 'Courier assignment alone does not establish physical collection or a delivery round.' },
  { wording: normalizeStatusWording('Accept'), note: 'Order acceptance alone does not establish physical collection.' },
] };
