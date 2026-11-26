import type { Stage } from '../../core/status/index.js';
import { normalizeStatusWording, type CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Expeditors words its shipment statuses and its events without codes: the map reads each wording whole.
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.flatMap((entry) => (entry.stage
  ? [[normalizeStatusWording(entry.wording), entry.stage as Stage] as const] : [])));

/** The stage of a shipment status or an event, by its wording. */
export const expeditorsStage = (wording: string): Stage | undefined => STAGES.get(normalizeStatusWording(wording));

export const statusMap: CarrierStatusMap = {
  wholeWording: true,
  stage: (_code, wording) => STAGES.get(wording),
  gaps: statuses.entries.flatMap((entry) => (entry.stage ? [] : [{ wording: normalizeStatusWording(entry.wording), note: entry.note! }])),
};
