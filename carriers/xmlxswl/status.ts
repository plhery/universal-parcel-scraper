import { lqfastStatus } from '../anjiexin56/lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/** Longxinshun's rows by the wordings in `statuses.json`, else the shared wording rules. */
export const { stage: lxsStage, statusMap } = lqfastStatus(statuses.entries);
