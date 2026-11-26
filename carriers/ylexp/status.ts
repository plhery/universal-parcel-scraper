import { ginfoStatus } from '../hgd/ginfoStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/** Yi Long's rows carry no code: the map is the wordings in `statuses.json`, then the shared wording rules. */
export const { stage: ylexpStage, statusMap } = ginfoStatus(statuses.entries);
