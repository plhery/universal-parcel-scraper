import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const CODES = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));
const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
export function qatarPostStage(code: string, wording: string): ClassifiedWording | null {
  const stage = code ? CODES.get(code) : WORDINGS.get(normalizeStatusWording(wording));
  return stage ? { stage, source: 'carrier_map' } : null;
}
export const statusMap: CarrierStatusMap = { stage: (code, wording) => code ? CODES.get(code) : WORDINGS.get(normalizeStatusWording(wording)), gaps: [] };
