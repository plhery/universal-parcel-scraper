import type { ClassifiedStatus, Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// Each status names the step of PIN's progress bar it belongs to. An item PIN
// cannot deliver ends the bar there; the page offers nothing after it.
const STAGES: Readonly<Record<string, ClassifiedStatus>> = {
  Sortierzentrum: { status: 'in_transit', stage: 'in_transit' },
  Zustelldepot: { status: 'in_transit', stage: 'in_transit' },
  'In Zustellung': { status: 'out_for_delivery', stage: 'out_for_delivery' },
  Zugestellt: { status: 'delivered', stage: 'delivered' },
  Unzustellbar: { status: 'exception', stage: 'exception' },
};

/** A status's reading from the step it names. */
export function pinAgStatus(stage: string): ClassifiedStatus | undefined {
  return Object.hasOwn(STAGES, stage) ? STAGES[stage] : undefined;
}

const CODES = new Map<string, Stage>(statuses.entries.map(({ code, stage }) => [code, stage as Stage]));

/** What the map says about a stored status: its code, recorded with the step it came with. */
export const statusMap: CarrierStatusMap = {
  stage: (code) => (code ? CODES.get(code) : undefined),
  gaps: [],
};
