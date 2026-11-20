import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';

const statuses: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^приета за събиране$/, 'registered'],
  [/^отложено събиране за /, 'registered'],
  [/^взета от куриер /, 'accepted'],
  [/^(?:приета в|транспорт към) хъб /, 'in_transit'],
  [/^приета за разнос$/, 'out_for_delivery'],
  [/^доставена(?: на .+)?$/, 'delivered'],
];

export function stageForScan(wording: string): Stage | undefined {
  const normalized = normalizeStatusWording(wording);
  return statuses.find(([pattern]) => pattern.test(normalized))?.[1];
}

/** The map reads a scan's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => stageForScan(wording),
  gaps: [],
};
