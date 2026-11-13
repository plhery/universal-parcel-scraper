/**
 * Brands that run several catalog networks ("DPD" is `dpd` and `dpd-fr`).
 *
 * Kept apart from the provider-name hints so browser code can use it without
 * their country tables.
 */

// Brands whose other networks keep the brand in front ("DHL Express", "GLS
// Italy"). "post" is left out: it also starts unrelated names.
export const NETWORK_BRANDS: readonly string[] = ['dhl', 'dpd', 'gls', 'hermes', 'evri', 'gofo', 'jumppoint'];

// Carriers under a brand's name that run a system of their own, which providers always name with
// their country. GLS US, once Golden State Overnight, tracks none of GLS's European parcels, and
// bare "GLS" stays the European networks' name, with their clocks.
const OWN_SYSTEMS: ReadonlySet<string> = new Set(['gls-us']);

/** The multi-network brand a catalog carrier belongs to ("dpd" for `dpd-fr`), if any. */
export function carrierBrand(id: string): string | undefined {
  if (OWN_SYSTEMS.has(id)) return undefined;
  return NETWORK_BRANDS.find((brand) => id === brand || id.startsWith(`${brand}-`));
}
