import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

const wordings = new Map(statuses.entries.flatMap((entry) =>
  'stage' in entry && entry.stage ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : []));

/** The stage UOF's recorded wording gives a scan. */
export function uofStage(wording: string): Stage | undefined {
  return wordings.get(normalizeStatusWording(wording));
}

/** The map reads a scan's wording, which comes without a code. */
export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => uofStage(wording),
  gaps: statuses.entries.flatMap((entry) => ('stage' in entry && entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note! }])),
};
