import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));
const byWording = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function jyldamStage(code: string | null | undefined, wording: string): Stage | undefined {
  return (code ? byCode.get(code) : undefined) ?? byWording.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: jyldamStage, gaps: [] };
