/**
 * Carrier names a universal provider reports for a shipment, mapped to catalog
 * ids when the mapping is unambiguous.
 *
 * The names are discovery hints: routing may use one to try a dedicated
 * adapter, but only that adapter confirming the shipment adopts the carrier.
 * Nothing here decides a carrier on its own.
 */
import type { CarrierId } from '../../generated/catalog.js';
import { brandCarrierIds, carrierIdFromName } from '../../core/catalog/hints.js';
import { checksumFailures } from '../../core/detection/detect.js';
import { detectCarrierMatch } from '../../core/detection/index.js';

export { isKnownCarrierName } from '../../core/catalog/hints.js';

/**
 * A bare brand ("DPD Group") names several catalog networks; the number can
 * still pick one. Keep the networks whose detection rules match it, then the
 * one a preferred rule backs, such as a DPD depot range. Anything else stays
 * unresolved rather than guessed.
 */
export function brandCarrierForNumber(name: string, trackingNumber: string): string | undefined {
  const networks = brandCarrierIds(name);
  if (!networks.length) return undefined;
  const detected = detectCarrierMatch(trackingNumber);
  const matching = networks.filter((id) => detected.candidates.includes(id as CarrierId));
  if (matching.length === 1) return matching[0];
  const preferred = matching.filter((id) => detected.preferred.includes(id as CarrierId));
  return preferred.length === 1 ? preferred[0] : undefined;
}

/**
 * Detection rules whose check digit the carrier's own adapter verifies before
 * any request: it refuses a number that fits the rule but fails the check as
 * invalid input, whatever other carriers' rules make of the number. Other
 * rules are left out, because their carrier may still know such a number.
 */
export const ADAPTER_CHECKED_RULES: ReadonlySet<string> = new Set([
  'dhl-express-waybill', 'gls-fr-4', 'mondial-relay-1',
  // FedEx label barcodes, tracked by the number they carry.
  'fedex-3', 'fedex-4',
  // S10 postal items.
  'austrian-post-2', 'bpost-3', 'bring-posten-1', 'canada-post-2', 'correios-br-1', 'correos-chile-2', 'ctt-1',
  'india-post-1', 'japan-post-1', 'nz-post-1', 'poczta-polska-s10', 'postnord-2', 'thailand-post-1', 'usps-s10',
]);

/**
 * Names are hints only. A direct adapter must confirm the shipment before
 * adoption. The looked-up number resolves a bare brand name, and rules out a
 * carrier whose adapter would refuse it for a failed check digit.
 */
export function universalCarrierHints(raw: unknown[], trackingNumber?: string): { reported_carriers: string[]; discovered_carrier?: string } {
  const names = [...new Set(raw.filter((value): value is string => typeof value === 'string'
    && value.length <= 80 && /^[\p{L}\p{N} .&'()-]+$/u.test(value)).map((value) => value.trim()))].filter(Boolean).slice(0, 10);
  const refused = new Set(trackingNumber ? checksumFailures(trackingNumber)
    .filter(({ rule }) => ADAPTER_CHECKED_RULES.has(rule)).map(({ carrier }) => carrier as string) : []);
  const detected = new Set<string>();
  for (const name of names) {
    const carrier = carrierIdFromName(name) ?? (trackingNumber ? brandCarrierForNumber(name, trackingNumber) : undefined);
    if (carrier && !refused.has(carrier)) detected.add(carrier);
  }
  return { reported_carriers: names,
    ...(names.length === 1 && detected.size === 1 ? { discovered_carrier: [...detected][0] } : {}),
  };
}
