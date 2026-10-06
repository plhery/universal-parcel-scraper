import { canadaProvinceTimeZone, countryTimeZone, regionHasTown, usStateTimeZone } from '../../core/time/index.js';

// DHL names a US state in full ("Ohio", "New York") or with its code ("VIRGINIA,VA").
const US_STATES: Readonly<Record<string, string>> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE',
  NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA',
  WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
};
// A Canadian province comes as its name or its code: "ONTARIO" and "ON" on scans of one parcel.
const CANADA_PROVINCES: Readonly<Record<string, string>> = {
  ALBERTA: 'AB', 'BRITISH COLUMBIA': 'BC', MANITOBA: 'MB', 'NEW BRUNSWICK': 'NB', 'NEWFOUNDLAND AND LABRADOR': 'NL',
  'NOVA SCOTIA': 'NS', 'NORTHWEST TERRITORIES': 'NT', NUNAVUT: 'NU', ONTARIO: 'ON', 'PRINCE EDWARD ISLAND': 'PE',
  QUEBEC: 'QC', SASKATCHEWAN: 'SK', YUKON: 'YT',
};
// Island groups an hour behind their mainland, which DHL files under the country.
const ISLANDS: Readonly<Record<string, { group: string; zone: string }>> = {
  'Europe/Madrid': { group: 'ES-CN', zone: 'Atlantic/Canary' },
  'Europe/Lisbon': { group: 'PT-20', zone: 'Atlantic/Azores' },
};

function regionCode(region: string, names: Readonly<Record<string, string>>): string {
  const parts = region.toUpperCase().split(',').map((part) => part.trim());
  return parts.find((part) => /^[A-Z]{2}$/.test(part)) ?? parts.map((part) => names[part]).find(Boolean) ?? '';
}

/**
 * The zone of a DHL Express facility, from its location: "CITY - COUNTRY", or
 * "CITY - REGION - COUNTRY" in the USA and Canada. Null when the location does
 * not settle one: a country with several clocks and no region DHL names, or a
 * country it writes in a form this does not know.
 *
 * A US state or Canadian province with several clocks takes its majority zone.
 * Spain and Portugal take their mainland's, except for a town or island of the
 * Canary Islands or the Azores.
 */
export function facilityZone(location: string): string | null {
  const parts = location.split(' - ').map((part) => part.trim());
  const country = parts.length > 1 ? parts.at(-1)!.toUpperCase() : '';
  const region = parts.length > 2 ? parts.at(-2)! : '';
  if (country === 'USA') return usStateTimeZone(regionCode(region, US_STATES));
  if (country === 'CANADA') return canadaProvinceTimeZone(regionCode(region, CANADA_PROVINCES));
  if (country === 'UK') return 'Europe/London';
  // DHL writes some countries article last, and some with a comma: "NETHERLANDS, THE".
  const zone = countryTimeZone(country.replace(/, THE$/, '').replaceAll(',', ''));
  const islands = zone ? ISLANDS[zone] : undefined;
  return islands && regionHasTown(islands.group, parts[0]!) ? islands.zone : zone;
}
