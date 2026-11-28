import type { CarrierResult } from '../../core/result/index.js';
import { packageLogsNumber, parsePackageLogs, type PackageLogsTenant } from './packageLogs.js';
import { theHumanStatus } from './status.js';

export const PROVIDER = 'The Human Express';
export const CARRIER = 'the-human-express';
/** The logs lookup The Human Express's tracking page posts to. */
export const THE_HUMAN_LOGS = 'https://api.thehuman.express/v1/shipment/packages/logs';
export const THE_HUMAN_PAGE = 'https://thehuman.express/trackings';

export const THE_HUMAN: PackageLogsTenant = {
  carrier: CARRIER, provider: PROVIDER, endpoint: THE_HUMAN_LOGS, page: THE_HUMAN_PAGE, status: theHumanStatus,
};

/** A The Human Express code, as its tracking page sends it. */
export function normalizeTheHumanNumber(raw: string): string {
  return packageLogsNumber(raw, PROVIDER);
}

/** The reply of The Human Express's logs lookup. */
export function parseTheHuman(payload: unknown, raw: string): CarrierResult {
  return parsePackageLogs(THE_HUMAN, payload, raw);
}
