import { ginfoStatus } from '../hgd/ginfoStatus.js';
import statuses from './statuses.json' with { type: 'json' };

/**
 * SRJ's own rows carry no code; the rows its line relays, USPS's among them, carry the line's code,
 * and an entry records the two. Anything else goes through the shared wording rules.
 */
export const { stage: srjStage, statusMap } = ginfoStatus(statuses.entries);
