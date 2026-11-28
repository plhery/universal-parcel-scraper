/**
 * Oversea Express's rows: a text without a code, the platform's own or one the courier in China wrote. An entry of
 * `statuses.json` records a text in the form `dsyTemplate` gives it; a text the map does not know goes through the
 * shared wording rules.
 */
import { dsyStatusMap } from './dsyexpressStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const statusMap = dsyStatusMap(statuses.entries);
