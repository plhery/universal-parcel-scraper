import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker words each history row without a code, so the map reads the wording whole.
const STAGES: ReadonlyMap<string, Stage | null> = new Map(statuses.entries
  .map(entry => [entry.wording.toLowerCase(), entry.stage as Stage | null]));

export const alaskaAirCargoStage = (wording: string): Stage | undefined => STAGES.get(wording.toLowerCase()) ?? undefined;

/** The stages that hold only at the waybill's destination; elsewhere the freight is still on its way. */
export const arrivalStages: ReadonlySet<Stage> = new Set<Stage>(['ready_for_pickup', 'delivered']);
