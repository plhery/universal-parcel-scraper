import type { Stage } from '../../core/status/index.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each status-history row by its Cargo-IMP event code and words it from its own
// translations, the same wording whether the step is planned or done.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage | null }> = new Map(statuses.entries
  .map(entry => [entry.code, { wording: entry.wording, stage: entry.stage as Stage | null }]));

/** The tracker's wording of a discrepancy row, by its discrepancy code, on a flight and at a station. */
const DISCREPANCIES: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['OFLD', ['Offload (OFLD)', 'Offload (OFLD)']],
  ['SSPD', ['Missing pieces on flight (SSPD)', 'Missing pieces on flight (SSPD)']],
  ['MSCA', ['Missing cargo (MSCA)', 'Missing pieces at station (MSCA)']],
  ['FDCA', ['Found cargo (FDCA)', 'Found cargo at station (FDCA)']],
  ['OVCD', ['Overcarried (OVCD)', 'Overcarried (OVCD)']],
]);

export const lufthansaCargoStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage ?? undefined;
export const lufthansaCargoWording = (code: string): string | undefined => ENTRIES.get(code)?.wording;
export const lufthansaCargoDiscrepancy = (code: string, onFlight: boolean): string | undefined =>
  DISCREPANCIES.get(code)?.[onFlight ? 0 : 1];

/** The stages that hold only at the waybill's destination; elsewhere the goods are still on their way. */
export const arrivalStages: ReadonlySet<Stage> = new Set<Stage>(['ready_for_pickup', 'delivered']);
