import { ambiguousAddressCodes, countryName, trackingPlace } from '../../places/trackingLocation.js';

/**
 * A name that reads as a place, or ''. Codes, ambiguous capitals-only names
 * and the module's carrier names are none.
 */
export function placeName(value: string, carriers: ReadonlySet<string>): string {
  const place = value.trim();
  // An explicit numbered city district is a place even in uppercase. Keep
  // arbitrary numbers and facility codes excluded from the general rule.
  const arrondissement = /^(?:Paris (?:[1-9]|1\d|20)|Lyon [1-9]|Marseille (?:[1-9]|1[0-6]))(?:er|e|eme|ème) arrondissement$/i.test(place);
  const letters = place.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 3 || (!arrondissement && (!/^\p{L}[\p{L}\p{M} .'’-]*$/u.test(place)
    || (/\p{Lu}/u.test(place) && !/\p{Ll}/u.test(place)))) || carriers.has(place.toLocaleLowerCase('en-US'))) {
    return '';
  }
  return place;
}

/**
 * The town of a bracket that names its country first, "[USA,Example City]" or
 * "[ES,Example Town 00000]", followed by that country, or ''. After a country
 * a town in capitals counts too, with five letters or more or several words.
 */
function countryFirst(value: string, carriers: ReadonlySet<string>): string {
  const [, head = '', rest = ''] = /^([^,]+),([^,]+)$/u.exec(value) ?? [];
  const { country, place } = trackingPlace(head);
  if (!country || place) return '';
  const [, town = '', postcode] = /^(.*?)(?:\s+(\d{4,5}))?$/u.exec(rest.trim())!;
  const letters = town.match(/\p{L}/gu)?.length ?? 0;
  const capitals = /^\p{Lu}[\p{Lu}\p{M} .'’-]*$/u.test(town) && (letters >= 5 || (letters >= 3 && /\s/u.test(town)))
    && !carriers.has(town.toLocaleLowerCase('en-US'));
  const name = capitals ? town : placeName(town, carriers);
  // A code a state shares ("CA") is written out, so the location keeps its country.
  const label = ambiguousAddressCodes.has(head.trim()) ? countryName(country, 'en') : head.trim();
  return name && `${postcode ? `${name} ${postcode}` : name}, ${label}`;
}

/**
 * Cainiao's global feed has no place field: it writes a scan's town in front
 * of its standard wording, "[Bordeaux] Out for delivery", in every language,
 * sometimes after its country, "[USA,Example City]". A bracket that reads as a place
 * becomes the location and the wording keeps the rest.
 */
export function placedWording(wording: string, carriers: ReadonlySet<string>): { description: string; location: string } {
  const match = /^\s*\[([^[\]]{1,80})\]\s*(\S[\s\S]*)$/.exec(wording);
  const place = match ? countryFirst(match[1]!, carriers) || placeName(match[1]!, carriers) : '';
  return place ? { description: match![2]!.trim(), location: place } : { description: wording, location: '' };
}
