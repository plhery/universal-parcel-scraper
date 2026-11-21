import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The tracker names each event by a three-letter Cargo-IMP code, worded by the page's own
// translations: one wording once the step is processed, another while it is still planned.
const ENTRIES: ReadonlyMap<string, { wording: string; stage: Stage | null }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: entry.stage as Stage | null }]));

const PLANNED: ReadonlyMap<string, string> = new Map([
  ['BKD', 'Planned for booking'], ['CPT', 'Planned FWB Reception from Forwarder'], ['FOH', 'Planned to be on hand'],
  ['RCS', 'Planned for acceptance'], ['MAN', 'Planned manifest for the flight'], ['DEP', 'Planned to depart'],
  ['ARR', 'Planned to arrive'], ['RCF', 'Planned for reception'], ['RCT', 'Planned receival from carrier'],
  ['TFD', 'Planned transfer to carrier'], ['AWR', 'Planned arrival documents'], ['NFD', 'Planned pick up'],
  ['AWD', 'Planned delivery of documents'], ['DLV', 'Planned for delivery'],
]);

export const cargoluxStage = (code: string): Stage | undefined => ENTRIES.get(code)?.stage ?? undefined;
export const cargoluxActual = (code: string): string | undefined => ENTRIES.get(code)?.wording;
export const cargoluxPlanned = (code: string): string | undefined => PLANNED.get(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? cargoluxStage(code) : undefined),
  gaps: statuses.entries.filter((entry) => entry.stage === null).map((entry) => ({ code: entry.code, note: entry.note ?? '' })),
};
