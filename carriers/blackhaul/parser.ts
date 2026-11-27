import type { CarrierResult } from '../../core/result/index.js';
import { normalizeTransvirtualNumber, parseTransvirtualPage, type TransvirtualPortal } from '../vt-freight-express/transvirtual.js';
import { blackhaulStage } from './status.js';

/**
 * Blackhaul's portal on Transvirtual. Its own tracking page embeds
 * Transvirtual's widget with this code; Transvirtual's portal serves the
 * same consignments at `/Track/654472/{number}`, under Blackhaul's logo.
 */
export const BLACKHAUL_PORTAL: TransvirtualPortal = {
  carrier: 'blackhaul', provider: 'Blackhaul', code: '654472', tracker: 'https://portal.transvirtual.com/Track/654472/', stage: blackhaulStage,
};

/** A number for Blackhaul's tracker, in upper case; anything else is not one it issues. */
export function normalizeBlackhaulNumber(raw: string): string {
  return normalizeTransvirtualNumber(BLACKHAUL_PORTAL, raw);
}

/** The page Blackhaul's tracker serves at `/Track/654472/{number}`: see `parseTransvirtualPage`. */
export function parseBlackhaul(html: string, raw: string): CarrierResult {
  return parseTransvirtualPage(BLACKHAUL_PORTAL, html, raw);
}
