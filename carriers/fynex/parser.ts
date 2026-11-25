import type { CarrierResult } from '../../core/result/index.js';
import { fynexStage, statusMap } from './status.js';
import { normalizeTssSmartNumber, parseTssSmart, type TssSmartSite } from './tssSmart.js';

/** FyNEX's tracking page on TSS Smart's courier build. */
export const fynex: TssSmartSite = {
  carrier: 'fynex',
  name: 'FyNEX',
  tracker: 'https://fynexcourierdubai.com/tracking/',
  // The page takes any number and FyNEX publishes no layout; the numbers seen are digits.
  layout: /^(?=[A-Z]*\d)[A-Z0-9]{5,30}$/,
  layoutMessage: 'FyNEX tracks numbers of 5 to 30 letters and digits',
  stage: fynexStage,
  statusMap,
};

export function normalizeFynexNumber(raw: string): string {
  return normalizeTssSmartNumber(raw, fynex);
}

/** FyNEX's tracking page for one number. */
export function parseFynex(html: string, raw: string): CarrierResult {
  return parseTssSmart(html, raw, fynex);
}
