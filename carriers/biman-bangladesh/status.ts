import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// CHAMP's tracker names each event by a fixed English status beside its sentence:
// "Departed", then "Part shipment of 393 pieces … departed from … on flight …".
const STAGES: ReadonlyMap<string, Stage> = new Map(statuses.entries.map(entry => [entry.code, entry.stage as Stage]));

export const freightAeroStage = (status: string): Stage | undefined => STAGES.get(status);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? freightAeroStage(code) : undefined),
  gaps: [],
};
