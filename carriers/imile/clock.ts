/**
 * The clock iMile's tracker shows a parcel's scans on, which other feeds relaying
 * them keep (providers/ship24).
 */
import { countryTimeZone } from '../../core/time/index.js';
import { countryZones } from '../../places/zones.js';

/**
 * The clock of a country iMile delivers in on several. New Zealand's other zone is
 * the Chatham Islands': its delivery stations keep Auckland's clock. iMile Australia
 * dates every scan on Sydney's, Queensland's included: on Brisbane's clock, its
 * hubs' arrivals there would come after a consumer first saw them.
 */
const COUNTRY_CLOCKS: Readonly<Record<string, string>> = { NZ: 'Pacific/Auckland', AU: 'Australia/Sydney' };

/**
 * The zone of the recipient country's clock, which every scan shows, where iMile
 * delivers on one. iMile names a country, never a state or province, so Peru's
 * code is Peru's. Null for a country whose clock the scans do not say.
 */
export function imileCountryClock(country: string): string | null {
  const zones = countryZones(country);
  return countryTimeZone(country) ?? (zones.length === 1 ? zones[0]! : COUNTRY_CLOCKS[country] ?? null);
}
