/**
 * SD Group's rows: a text without a code, the platform's own, its line-haul feed's or one Yunda wrote. An entry of
 * `statuses.json` records a text in the form `dsyTemplate` gives it; a text the map does not know goes through the
 * shared wording rules.
 */
import { dsyStatusMap } from '../overseaex/dsyexpressStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const statusMap = dsyStatusMap(statuses.entries);
