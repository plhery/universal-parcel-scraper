import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

// Each milestone names its Cargo-IMP status code; the reply words it with the station and flight.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage | null }> = new Map(statuses.entries
  .map(entry => [entry.code, { wording: entry.wording, stage: entry.stage as Stage | null }]));

export const emiratesSkyCargoStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage ?? undefined;
export const emiratesSkyCargoWording = (code: string): string | undefined => ENTRIES.get(code)?.wording;

/** The stages that hold only at the waybill's destination; elsewhere the goods are still on their way. */
export const arrivalStages: ReadonlySet<Stage> = new Set<Stage>(['ready_for_pickup', 'delivered']);
