import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const WORDINGS = new Map<string, Stage>(statuses.entries.map((entry) => [normalizeStatusWording(entry.wording), entry.stage as Stage]));
// The platform's scripted rows that name an airport or a customs office in brackets: `抵达【LAX】`.
const BRACKETED: readonly (readonly [RegExp, Stage])[] = [
  [/^启运【[^】\]]*[】\]]$/u, 'in_transit'],
  [/^抵达【[^】\]]*[】\]]$/u, 'in_transit'],
  [/^快件到达始发地海关【[^】\]]*[】\]][,，]?\s*等待清关$/u, 'in_transit'],
];

/**
 * The stage GTI's map gives one of its own rows, by its `normalizeStatusWording` wording; a
 * scripted row that names a place in brackets reads the same whatever the place. The rows it
 * copies from USPS are left to the shared wording rules.
 */
export function gtiStage(_code: string | null, wording: string): Stage | undefined {
  return WORDINGS.get(wording) ?? BRACKETED.find(([pattern]) => pattern.test(wording))?.[1];
}

export const statusMap: CarrierStatusMap = { stage: gtiStage, gaps: [] };
