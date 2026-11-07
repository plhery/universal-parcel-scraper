import { countryTimeZone, regionHasTown, townKey } from '../../core/time/index.js';

/**
 * CTT's clocks. CTT dates a scan with the wall clock of the place it happened
 * and writes it with a Z: its tracker is an OutSystems app, whose DateTime
 * values travel as UTC strings, and its page shows the digits as they are
 * whatever the viewer's zone. UPU's tracking has the same wall clocks for
 * CTT's posting and dispatch, and 17TRACK reads them on Lisbon's clock
 * (checked 2026-10-10). The destination post's scans keep its own wall clock:
 * an Italian delivery comes at the Italian office's time. So do the origin
 * post's scans of mail from abroad.
 */

/** A UPU office of exchange leading a location: "PTLISA - (OUTRO) LISBOA". */
const OFFICE = /^([A-Z]{2})[A-Z0-9]{4}(?=\s+-\s)/;
/** CTT's own sites: a sorting centre, also written C.O., a delivery centre (CDP), a shop or a postal point. */
const CTT_SITE = /\b(?:CTT|CDP|centro operacional|centro de distribui[cç][aã]o)\b|\bC\.O\.(?!\S)/i;
/** A Portuguese postcode; 9500 to 9999 are the Azores. */
const POSTCODE = /(?<!\d)(\d{4})(?:-\d{3})?(?!\d)/;

/**
 * The clock of a scan in Portugal: the Azores keep one an hour behind the
 * mainland and Madeira. A location names them by postcode or by a town only
 * the islands have.
 */
export function portugalZone(location: string): string {
  const postcode = POSTCODE.exec(location)?.[1];
  if (postcode) return Number(postcode) >= 9500 ? 'Atlantic/Azores' : 'Europe/Lisbon';
  const town = location.replace(OFFICE, '').replace(/\([^)]*\)/g, ' ').replace(/^[\s\d-]+/, '')
    .replace(/\b(?:loja|ponto|centro operacional|CTT|CDP)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return town && regionHasTown('PT-20', town) ? 'Atlantic/Azores' : 'Europe/Lisbon';
}

/**
 * One of CTT Express's agencies in Spain, as CTT names it on a parcel CTT
 * Express hands over: a six-digit code starting 00, like every code in CTT
 * Express's agency list, and its kind ("009999 - (PL) CENTRO DE TRATAMIENTO
 * ADUANERO"). CTT gives such a scan Madrid's wall clock: CTT Express's own
 * tracker dates the same arrival 17:12:27.063Z where CTT shows 19:12:27.
 */
const CTT_EXPRESS_AGENCY = /^00\d{4}\s+-\s+\(/;

/**
 * Spain's provincial capitals and its two autonomous cities, which CTT names bare, without a
 * code, on the scans of CTT Express's network: the shipment record CTT Express sends it,
 * CTT Express's hand-over and a delivery round in Spain. Such a scan keeps the town's wall
 * clock: CTT Express's own tracker dates the shipment record an hour before CTT's digits for
 * Barcelona in winter and two hours for Madrid in summer, to the second, and its dispatch the
 * same hour before CTT's arrival at Barcelona.
 */
const SPANISH_CAPITALS = new Set([
  'A Coruña', 'La Coruña', 'Albacete', 'Alicante', 'Alacant', 'Almería', 'Ávila', 'Badajoz', 'Barcelona', 'Bilbao',
  'Burgos', 'Cáceres', 'Cádiz', 'Castellón', 'Castellón de la Plana', 'Castelló', 'Ciudad Real', 'Córdoba', 'Cuenca',
  'Girona', 'Gerona', 'Granada', 'Guadalajara', 'Huelva', 'Huesca', 'Jaén', 'León', 'Lleida', 'Lérida', 'Logroño',
  'Lugo', 'Madrid', 'Málaga', 'Murcia', 'Ourense', 'Orense', 'Oviedo', 'Palencia', 'Palma', 'Palma de Mallorca',
  'Pamplona', 'Iruña', 'Pontevedra', 'Salamanca', 'San Sebastián', 'Donostia', 'Santander', 'Segovia', 'Sevilla',
  'Soria', 'Tarragona', 'Teruel', 'Toledo', 'Valencia', 'València', 'Valladolid', 'Vitoria', 'Vitoria-Gasteiz',
  'Zamora', 'Zaragoza', 'Ceuta', 'Melilla',
].map(townKey));
/** The Canary Islands' two capitals, an hour behind the mainland. */
const CANARY_CAPITALS = new Set(['Las Palmas', 'Las Palmas de Gran Canaria', 'Santa Cruz de Tenerife'].map(townKey));

/**
 * The clock of a Spanish provincial capital a location names bare, unless the parcel's
 * `countries` include one besides Spain and Portugal, where a town of that name may lie.
 */
function spanishTownZone(location: string, countries: readonly (string | null)[]): string | null {
  if (countries.some((country) => country && country !== 'ES' && country !== 'PT')) return null;
  const town = townKey(location);
  if (!town || !/^[\p{L} .'-]+$/u.test(location.trim())) return null;
  return CANARY_CAPITALS.has(town) ? 'Atlantic/Canary' : SPANISH_CAPITALS.has(town) ? 'Europe/Madrid' : null;
}

/** Whether a location names one of CTT Express's agencies, not one of CTT's own sites. */
export function isCttExpressAgency(location: string): boolean {
  return CTT_EXPRESS_AGENCY.test(location) && !CTT_SITE.test(location);
}

/**
 * Whether a location is one of CTT Express's: one of its agencies or a Spanish provincial
 * capital named bare. CTT records its acceptance with no place as the parcel reaches either.
 */
export function isCttExpressPlace(location: string): boolean {
  return isCttExpressAgency(location) || spanishTownZone(location, []) !== null;
}

/** The acceptance CTT records with no place as a CTT Express agency takes a parcel in comes up to this long before. */
const AGENCY_INTAKE_MS = 60_000;

/**
 * Whether a CTT scan with no place, at `at`, is that acceptance: at most a minute before one of
 * `agencyScans`, the scans at CTT Express's places (`isCttExpressPlace`). Both are wall clocks
 * read as UTC, only to compare them. It is on Madrid's clock, as the agency's scan is.
 */
export function agencyIntake(at: number, agencyScans: readonly number[]): boolean {
  return agencyScans.some((agency) => agency - at >= 0 && agency - at <= AGENCY_INTAKE_MS);
}

/** The country of the office of exchange leading a location, if one does. */
export function officeCountry(location: string): string | null {
  return OFFICE.exec(location)?.[1] ?? null;
}

/**
 * The clock a CTT scan's location itself names: the country of the office of
 * exchange leading it, when that is Portugal or one of `countries` (the
 * parcel's), Madrid's for one of CTT Express's agencies, a Spanish provincial
 * capital's, else Portugal's for one of CTT's own sites. Null when the location
 * does not say. Providers' copies of CTT's scans keep CTT's digits, so they take
 * the same clocks.
 */
export function cttSiteZone(location: string, countries: readonly (string | null)[]): string | null {
  const office = officeCountry(location);
  if (office === 'PT' || (office && countries.includes(office))) {
    return office === 'PT' ? portugalZone(location) : countryTimeZone(office);
  }
  if (isCttExpressAgency(location)) return 'Europe/Madrid';
  return spanishTownZone(location, countries) ?? (CTT_SITE.test(location) ? portugalZone(location) : null);
}
