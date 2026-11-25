import { normalizeStatusWording } from '../../core/status/statusMap.js';
import statuses from './statuses.json' with { type: 'json' };

// The wordings of Micro Express's coded events, its own words; "Delivered" and "In Transit" are anyone's.
const COPIED = new Set(statuses.entries.flatMap((entry) => 'code' in entry && entry.code ? [normalizeStatusWording(entry.wording)] : []));

/**
 * Whether a row a line's tracker shows is Micro Express's, copied in its words once it is the line's courier in
 * Australia. JS Express gives those copies on UTC, to the second: the instant Micro Express's own tracker gives
 * the same scan. Read on Melbourne's clock, they would come eleven hours early.
 */
export const isMicroExpressCopy = (description: string): boolean => COPIED.has(normalizeStatusWording(description));
