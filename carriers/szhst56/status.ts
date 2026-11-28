import { lqfastStatus } from '../anjiexin56/lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Hongshuntong's rows by the wordings in `statuses.json`, `…` standing for the part that varies,
 * else the shared wording rules. Lanqiao's template reader, which carries no transport, reads them.
 */
export const { stage: szhst56Stage, statusMap } = lqfastStatus(statuses.entries);
