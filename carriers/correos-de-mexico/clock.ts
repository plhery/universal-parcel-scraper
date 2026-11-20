import { countryCode, countryTimeZone, mislabeledLocalTime } from '../../core/time/index.js';

/**
 * Correos de México's clocks. Its offices on central time write Mexico City's.
 * A foreign post's scan comes through as that post's data gives it, and some
 * posts' data gives their offices' wall clocks as UTC times, which the tracker
 * shows on Mexico City's clock, six hours early: 4-72's arrival of an item in
 * Colombia and the start of its customs inspection came six hours before UPU's
 * copies of them, which carry 4-72's own digits.
 */
export const CORREOS_DE_MEXICO_ZONE = 'America/Mexico_City';

// Countries whose post's data gives its offices' wall clocks as UTC times.
const WALL_CLOCK_AS_UTC: ReadonlySet<string> = new Set(['CO']);
// States wholly on central time, UTC−6 all year since Mexico dropped summer
// time in 2022, by the abbreviation the tracker prints after an office, with
// its accents, dots and spaces removed. Offices elsewhere, in states with
// several zones, and abroad keep their wall clocks, but for a post whose
// clock the tracker shifts (`correosDeMexicoForeignClock`).
const CENTRAL_STATES = new Set(['ags', 'camp', 'chis', 'cdmx', 'df', 'col', 'dgo', 'gto', 'gro', 'hgo', 'jal', 'mex', 'edomex',
  'mich', 'mor', 'oax', 'pue', 'qro', 'slp', 'tab', 'tlax', 'ver', 'yuc', 'zac']);
// Mexico City's own names, which the tracker can print without a comma before them.
const CAPITAL = new Set(['cdmx', 'df']);
// A UPU office code, as the tracker names a foreign post's office: two letters for its country,
// three for its place and one more.
const POSTAL_OFFICE = /^([A-Z]{2})[A-Z]{3}[A-Z0-9]$/;
// Mexican places of that shape.
const MEXICAN_PLACES: ReadonlySet<string> = new Set(['COLIMA', 'COCULA']);

/** The country abroad a scan's place names, by its name ("COLOMBIA") or its UPU office code. */
function foreignCountry(location: string, colombianRoute: boolean): string | null {
  const place = location.trim();
  const office = !MEXICAN_PLACES.has(place.toUpperCase()) && (colombianRoute || place === 'COBOGC')
    ? POSTAL_OFFICE.exec(place)?.[1] : undefined;
  const country = countryCode(place) ?? (office ? countryCode(office) : null);
  return country && country !== 'MX' ? country : null;
}

/**
 * The clock of a foreign post's scan that the tracker shows from that post's
 * wall clock read as UTC: the post's zone and its wall clock, as offset-less
 * digits. Null for any other scan.
 */
export function correosDeMexicoForeignClock(location: string, shown: unknown, colombianRoute = false): { zone: string; wall: string } | null {
  const country = foreignCountry(location, colombianRoute);
  const zone = country && WALL_CLOCK_AS_UTC.has(country) ? countryTimeZone(country) : null;
  const read = zone ? mislabeledLocalTime(shown, CORREOS_DE_MEXICO_ZONE) : null;
  return zone && read ? { zone, wall: new Date(read.timestamp).toISOString().slice(0, 19) } : null;
}

/** Whether an office's scans are on central time: its state, after the last comma, is wholly on it. */
function onCentralTime(location: string): boolean {
  const comma = location.lastIndexOf(',');
  const tail = comma >= 0 ? location.slice(comma + 1) : location.split(' ').at(-1) ?? '';
  const state = tail.normalize('NFD').replace(/[\u0300-\u036f.\s]/g, '').toLowerCase();
  return CENTRAL_STATES.has(state) && (comma >= 0 || CAPITAL.has(state));
}

/**
 * The clock a scan the tracker shows at `wall` is read on: a foreign post's own for one the tracker
 * shows shifted, Mexico City's for an office on central time. Null for a local wall clock.
 */
export function correosDeMexicoClock(location: string, wall: string, colombianRoute = false): { zone: string; wall: string } | null {
  return correosDeMexicoForeignClock(location, wall, colombianRoute)
    ?? (onCentralTime(location) ? { zone: CORREOS_DE_MEXICO_ZONE, wall } : null);
}
