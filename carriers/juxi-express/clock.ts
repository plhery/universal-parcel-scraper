import { countryCode, countryTimeZone } from '../../core/time/index.js';
import { locatePlace, placeTimeZone } from '../../places/index.js';

// Juxi Express's own rows, at its warehouses in China and with no place, are on Beijing's clock.
const HOME = new Set(['CN', 'HK', 'MO']);
const WORDING_KEY = (value: string) => value.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '').toLowerCase();

/**
 * The clock of a scan abroad that Juxi Express relays from the carrier delivering the parcel. Juxi
 * gives it at the facility's wall clock, and 17TRACK and ParcelsApp put Beijing's clock on it: a copy
 * of USPS's departure from a Chicago distribution center came ten hours before USPS's own acceptance
 * there, and on Chicago's clock 21 minutes before USPS's departure. Delivery rounds in Britain,
 * France and Florida came at night on Beijing's clock, and in the morning on their place's.
 *
 * The zone of the town, state or province its place names, or of the country when that keeps one
 * clock; null keeps its wall clock in a country of several. Undefined for Juxi's own rows: in China,
 * with no place, with a place that only repeats the wording ("Customs clearance in progress"), or
 * with one the gazetteer does not find.
 */
export function juxiExpressAbroadZone(location: string, wording: string, destination: string | null): string | null | undefined {
  if (!location.trim() || WORDING_KEY(location) === WORDING_KEY(wording)) return undefined;
  const bound = countryCode(destination);
  const found = locatePlace(location, { countries: bound ? [bound] : [], carriers: ['juxi-express'] });
  if (!found || HOME.has(found.country)) return undefined;
  return found.precision === 'country' && !found.region ? countryTimeZone(found.country) : placeTimeZone(found);
}
