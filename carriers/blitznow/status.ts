import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

interface Entry { wording: string; stage?: string; note?: string }
const entries: readonly Entry[] = statuses.entries;

// The tracker names each status in English; a scan row repeats the shipment's status names.
const WORDINGS: ReadonlyMap<string, Stage> = new Map(entries.flatMap(entry => (entry.stage
  ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : [])));
const gaps = entries.filter(entry => !entry.stage).map(entry => ({ wording: normalizeStatusWording(entry.wording), note: entry.note! }));

/** A status's stage by its whole name; a name the tracker does not list has none. */
export function blitzStage(status: string): Stage | undefined {
  return WORDINGS.get(normalizeStatusWording(status));
}

export const statusMap: CarrierStatusMap = {
  stage: (_code, wording) => WORDINGS.get(wording),
  gaps,
  wholeWording: true,
};
