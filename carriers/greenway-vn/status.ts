import type { CarrierStatusMap } from '../../core/status/statusMap.js';
import { packageLogsStatus } from '../the-human-express/status.js';
import statuses from './statuses.json' with { type: 'json' };

// Greenway runs on The Human Express's platform, with log wordings and package statuses of its own.
export const greenwayStatus = packageLogsStatus(statuses.entries);
export const statusMap: CarrierStatusMap = greenwayStatus.statusMap;
