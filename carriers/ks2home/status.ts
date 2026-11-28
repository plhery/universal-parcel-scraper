/**
 * Ks2Home's rows carry no code: each is a fixed heading and the line under it, which `statuses.json`
 * lists as the parser joins them, through the template reader the Lanqiao tenants use. A wording no
 * entry reads goes through the shared wording rules.
 */
import { lqfastStatus } from '../anjiexin56/lqfastStatus.js';
import statuses from './statuses.json' with { type: 'json' };

export const { stage: ks2homeStage, statusMap } = lqfastStatus(statuses.entries);
