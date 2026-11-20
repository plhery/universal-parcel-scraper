import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map(statuses.entries.map(({ code, stage }) => [code, stage as Stage]));
const byWording = new Map(statuses.entries.map(({ wording, stage }) => [normalizeStatusWording(wording), stage as Stage]));

export function obanaStage(code: string | null, wording: string): Stage | undefined {
  return (code ? byCode.get(code.toLowerCase()) : undefined) ?? byWording.get(normalizeStatusWording(wording));
}

export const statusMap: CarrierStatusMap = { stage: obanaStage, gaps: [], wholeWording: true };
