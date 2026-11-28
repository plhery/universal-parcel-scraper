import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each milestone by its Cargo-IMP code and words it from its own translations;
// the booking, the cancellation and the discrepancies come from its shipment status and alerts.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage | null }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage | null }]));

/** The tracker's headings for a milestone still to come, at its scheduled (S) or estimated (E) time. */
const PLANNED: ReadonlyMap<string, { S: string; E: string }> = new Map([
  ['DEP', { S: 'Planned departure', E: 'Estimated departure' }],
  ['ARR', { S: 'Planned arrival', E: 'Estimated arrival' }],
  ['NFD', { S: 'Estimated delivery', E: 'Estimated delivery' }],
]);

export const iagCargoStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage ?? undefined;
export const iagCargoWording = (code: string): string | undefined => ENTRIES.get(code)?.wording;
export const iagCargoPlanned = (code: string, estimated: boolean): string | undefined =>
  PLANNED.get(code)?.[estimated ? 'E' : 'S'] ?? ENTRIES.get(code)?.wording;

/** The stages that hold only at the waybill's destination; elsewhere the goods are still on their way. */
export const arrivalStages: ReadonlySet<Stage> = new Set<Stage>(['ready_for_pickup', 'delivered']);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? iagCargoStage(code) : undefined),
  gaps: statuses.entries.filter((entry) => entry.stage === null).map((entry) => ({ code: entry.code, note: entry.note ?? '' })),
};
