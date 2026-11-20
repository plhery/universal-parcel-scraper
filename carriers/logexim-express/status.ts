import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const byCode = new Map<string, Stage>();
const byWording = new Map<string, Stage>();
for (const { code, wording, stage } of statuses.entries) {
  if (code) byCode.set(code, stage as Stage);
  byWording.set(wording.toLowerCase(), stage as Stage);
}

export function logeximStage(code: string | null | undefined, wording: string): Stage | undefined {
  return (code ? byCode.get(code) : undefined) ?? byWording.get(wording.toLowerCase());
}

export const statusMap: CarrierStatusMap = { stage: logeximStage, gaps: [] };
