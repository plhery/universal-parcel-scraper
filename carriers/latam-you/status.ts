import type { Stage } from '../../core/status/index.js';
import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * The line's order states, `currentState` in a trace row, with the label its state list
 * (`/BaseData/orderStates`) gives each. The last-mile partner's rows carry them too.
 */
const STATES: ReadonlyMap<string, { wording: string; stage?: Stage; note: string }> = new Map(statuses.entries
  .map((entry) => [entry.code, { wording: entry.wording, stage: 'stage' in entry ? entry.stage as Stage : undefined, note: entry.note }]));

export const latamYouStage = (code: string): Stage | undefined => STATES.get(code)?.stage;
export const latamYouLabel = (code: string): string | undefined => STATES.get(code)?.wording;
export const isLatamYouState = (code: string): boolean => STATES.has(code);

export const statusMap: CarrierStatusMap = {
  stage: (code) => (code === null ? undefined : latamYouStage(code)),
  gaps: [...STATES].filter(([, state]) => !state.stage).map(([code, state]) => ({ code, note: state.note })),
};
