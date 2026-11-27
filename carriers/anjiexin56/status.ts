import { lqfastStatus } from './lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/** ANJIEXIN's rows by the wordings in `statuses.json`, else the shared wording rules. */
export const { stage: anjiexinStage, statusMap } = lqfastStatus(statuses.entries);
