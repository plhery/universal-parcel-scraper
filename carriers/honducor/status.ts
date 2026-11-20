import type { ClassifiedWording, Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };
import { honducorWording } from './wording.js';

const WORDINGS = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
export function honducorStage(wording: string): ClassifiedWording | null {
  const stage = WORDINGS.get(normalizeStatusWording(honducorWording(wording)));
  return stage ? { stage, source: 'carrier_map' } : null;
}
export const statusMap: CarrierStatusMap = { stage: (_code, wording) => WORDINGS.get(normalizeStatusWording(honducorWording(wording))), gaps: [] };
