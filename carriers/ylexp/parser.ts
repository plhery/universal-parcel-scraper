import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { GINFO_MAX_BYTES, parseGinfo, type GinfoTenant } from '../hgd/ginfo.js';
import { statusMap, ylexpStage } from './status.js';

export const PROVIDER = 'Yi Long Express';
export const CARRIER = 'ylexp';
export const YLEXP_MAX_BYTES = GINFO_MAX_BYTES;
/** Yi Long's tracking server, where its site's form posts. */
export const YLEXP_API = 'http://open.ylexp.com/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const YLEXP_SITE = 'http://www.ylexp.com/';
// Letters and digits, with a digit: the tracker takes the numbers of the networks Yi Long ships on.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,30}$/;

/** A waybill on Yi Long's tracker, without spaces or hyphens. */
export function normalizeYlexpNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Yi Long Express waybills are 8 to 30 letters and digits');
  return number;
}

/**
 * Yi Long's tenant of the GInfo server. Its page shows STATE 3 as delivered,
 * with a delivery time the rows may not reach.
 */
export const YLEXP: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: YLEXP_API, site: YLEXP_SITE, normalize: normalizeYlexpNumber, stage: ylexpStage, statusMap,
  deliveredState: true,
};

/** The record Yi Long's tracker returns for one number. */
export const parseYlexp = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(YLEXP, body, raw, readAt);
