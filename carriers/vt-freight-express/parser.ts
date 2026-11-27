import type { CarrierResult } from '../../core/result/index.js';
import { vtFreightExpressStage } from './status.js';
import {
  isTransvirtualBlockPage, normalizeTransvirtualNumber, parseTransvirtualPage, TRANSVIRTUAL_MAX_BYTES, type TransvirtualPortal,
} from './transvirtual.js';

export const PROVIDER = 'VT Freight Express';
export const CARRIER = 'vt-freight-express';
/** VT Freight Express's portal on its consignment software, as the tracker's address names it. */
export const PORTAL = 'VTFE';
export const VT_FREIGHT_EXPRESS_MAX_BYTES = TRANSVIRTUAL_MAX_BYTES;

/** VT Freight Express's tracker on Transvirtual. */
export const VT_FREIGHT_EXPRESS_PORTAL: TransvirtualPortal = {
  carrier: CARRIER, provider: PROVIDER, code: PORTAL, tracker: `https://portal.vtfe.com.au/Track/${PORTAL}/`, stage: vtFreightExpressStage,
};

/** A number for VT Freight Express's tracker, in upper case; anything else is not one it issues. */
export function normalizeVtFreightExpressNumber(raw: string): string {
  return normalizeTransvirtualNumber(VT_FREIGHT_EXPRESS_PORTAL, raw);
}

/** A firewall or bot-check page in place of the tracker's own. */
export const isBlockPage = isTransvirtualBlockPage;

/**
 * The page VT Freight Express's tracker serves at `/Track/VTFE/{number}`: see
 * `parseTransvirtualPage`. Consignments open with a prefix set per sender.
 */
export function parseVtFreightExpress(html: string, raw: string): CarrierResult {
  return parseTransvirtualPage(VT_FREIGHT_EXPRESS_PORTAL, html, raw);
}
