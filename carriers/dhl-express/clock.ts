import { countryTimeZone } from '../../core/time/index.js';

/**
 * The zone of a DHL Express facility, from its "CITY - COUNTRY" location, when
 * the country keeps one civil time. Spain and Portugal are left out: a country
 * cannot tell their islands' clocks from the mainland's.
 */
export function facilityZone(location: string): string | null {
  const separator = location.lastIndexOf(' - ');
  if (separator < 0) return null;
  // DHL writes some countries article last: "NETHERLANDS, THE".
  const zone = countryTimeZone(location.slice(separator + 3).replace(/, THE$/i, ''));
  return zone && !['Europe/Madrid', 'Europe/Lisbon'].includes(zone) ? zone : null;
}
