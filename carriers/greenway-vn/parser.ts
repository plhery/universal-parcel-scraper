import type { CarrierResult } from '../../core/result/index.js';
import { packageLogsNumber, parsePackageLogs, type PackageLogsTenant } from '../the-human-express/packageLogs.js';
import { greenwayStatus } from './status.js';

export const PROVIDER = 'Greenway';
export const CARRIER = 'greenway-vn';
/** The logs lookup Greenway's tracking page posts to. */
export const GREENWAY_LOGS = 'https://api.greenwayvn.com/v1/packages/logs';
export const GREENWAY_PAGE = 'https://greenwayvn.com/tracking';

export const GREENWAY: PackageLogsTenant = {
  carrier: CARRIER, provider: PROVIDER, endpoint: GREENWAY_LOGS, page: GREENWAY_PAGE, status: greenwayStatus,
};

/** A Greenway code, as its tracking page sends it. */
export function normalizeGreenwayNumber(raw: string): string {
  return packageLogsNumber(raw, PROVIDER);
}

/** The reply of Greenway's logs lookup. */
export function parseGreenway(payload: unknown, raw: string): CarrierResult {
  return parsePackageLogs(GREENWAY, payload, raw);
}
