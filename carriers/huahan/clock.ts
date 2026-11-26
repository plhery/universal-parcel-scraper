import { countryCode, countryTimeZone } from '../../core/time/index.js';
import { locatePlace, placeTimeZone } from '../../places/index.js';

// HuaHan's own rows are in China, or name no place.
const HOME = new Set(['CN', 'HK', 'MO']);

/**
 * The clock of a scan abroad that HuaHan relays from the carrier delivering the parcel, at that
 * facility's wall clock, as HuaHan's own page gives it and the line's own feed dates it to the
 * second. The zone of the town or state its place names, or of the country when that keeps one
 * clock; null keeps its wall clock in a country of several. Undefined for HuaHan's own rows: in
 * China, with no place, or with one the gazetteer does not find.
 */
export function huahanAbroadZone(location: string, destination: string | null): string | null | undefined {
  if (!location.trim()) return undefined;
  const bound = countryCode(destination);
  const found = locatePlace(location, { countries: bound ? [bound] : [] });
  if (!found || HOME.has(found.country)) return undefined;
  return found.precision === 'country' && !found.region ? countryTimeZone(found.country) : placeTimeZone(found);
}
