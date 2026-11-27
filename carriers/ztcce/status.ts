/**
 * ZTCCE's rows: the kdfei platform's state, kept as the scan's code, and a text. An entry of `statuses.json`
 * records a state with a text; a state whose every recorded text means one stage gives it to a text the map
 * does not know. Anything else goes through the shared wording rules.
 */
import { kdfeiStatusMap } from './kdfeiStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const statusMap = kdfeiStatusMap(statuses.entries);
