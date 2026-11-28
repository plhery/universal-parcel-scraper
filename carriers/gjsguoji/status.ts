/**
 * GJS Express's rows carry no code the firm documents. Its own sentences are fixed, and the
 * sentences of ZTO International and ZTO it copies name places: an entry of `statuses.json` writes the
 * varying part as `…`, through the template reader the Lanqiao tenants use. A wording no entry reads
 * goes through the shared wording rules.
 */
import { lqfastStatus } from '../anjiexin56/lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const { stage: gjsStage, statusMap } = lqfastStatus(statuses.entries);
