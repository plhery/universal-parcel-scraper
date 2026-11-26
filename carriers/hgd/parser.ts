import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { GINFO_MAX_BYTES, parseGinfo, type GinfoTenant } from './ginfo.js';
import { hgdStage, statusMap } from './status.js';

export const PROVIDER = 'HGD';
export const CARRIER = 'hgd';
export const HGD_MAX_BYTES = GINFO_MAX_BYTES;
/** The forwarder's tracking server, where its site's form posts. */
export const HGD_API = 'http://139.196.154.164/cgi-bin/GInfo.dll';
/** The site whose tracking form opens the server's page. */
export const HGD_SITE = 'http://www.365igo.com.cn/';
// HGD, the line's letters, digits and a closing pair, as the samples' HGDGY, ten digits and YQ.
const NUMBER = /^HGD[A-Z]{0,4}\d{8,14}[A-Z]{0,3}$/;

/** An HGD waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeHgdNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'HGD waybills are HGD, letters and digits');
  return number;
}

/** HGD's tenant of the GInfo server. Its page's status is not read: no delivered record was seen. */
export const HGD: GinfoTenant = {
  carrier: CARRIER, provider: PROVIDER, api: HGD_API, site: HGD_SITE, normalize: normalizeHgdNumber, stage: hgdStage, statusMap,
};

/**
 * The record HGD's tracker returns for one number. The destination is named
 * in Chinese and read as an ISO code; the weight is kept.
 */
export const parseHgd = (body: string, raw: string, readAt?: number): CarrierResult => parseGinfo(HGD, body, raw, readAt);
