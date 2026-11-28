import { lqfastStatus } from '../anjiexin56/lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * Huaxintai's rows by the wordings in `statuses.json`, else the shared wording rules. The rows read
 * like a Lanqiao tenant's, a sentence after an optional place in brackets, so Lanqiao's template
 * reader, which carries no transport, reads them too.
 */
export const { stage: huaxintaiStage, statusMap } = lqfastStatus(statuses.entries);
