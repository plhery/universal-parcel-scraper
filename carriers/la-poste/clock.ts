import { DateTime } from 'luxon';
import { countryTimeZone, explicitOffsetTime, isoTime } from '../../core/time/index.js';

/** France, Monaco, whose post La Poste runs, and the overseas places where La Poste scans items itself. */
export const LA_POSTE_COUNTRIES: ReadonlySet<string> = new Set(['FR', 'MC', 'GP', 'MQ', 'GF', 'RE', 'YT', 'PM', 'BL', 'MF']);

/** An international tracked letter La Poste sends abroad: `L`, a letter, nine digits and `FR`. */
export const EXPORTED_LETTER = /^L[A-Z]\d{9}FR$/;

/** Imported tracked mail, as La Poste names the product. */
export const IMPORT = 'lettre et ppi import suivi';

/**
 * The wall clock a partner post's scan abroad shows under La Poste's label:
 * Colissimo gives it Paris's offset, and tracked mail, imported or an
 * international tracked letter sent from France, reads it as UTC and shows it on
 * Paris's clock (a Dutch scan of such a letter reached the feed before the
 * instant it was labelled). Null for other products, whose partner scans have
 * not been compared with the partner's own.
 */
export function partnerWall(raw: string, product: string, exportedLetter: boolean): string | null {
  const labelled = DateTime.fromISO(raw, { setZone: true });
  const shown = product === 'colissimo' ? labelled
    : product === IMPORT || (exportedLetter && product !== 'chronopost') ? labelled.toUTC() : null;
  return shown?.toISO({ includeOffset: false, suppressMilliseconds: true }) ?? null;
}

/**
 * A partner post's scan abroad, read in the country's zone, or kept as a wall
 * clock when the country has several. Null at home, where an imported item's
 * arrival and transit keep the instant the relaying post shows to the minute,
 * and where `partnerWall` gives none.
 */
export function partnerClock(raw: string, country: string, product: string, exportedLetter: boolean): { time: string; local_time?: string } | null {
  if (!country || LA_POSTE_COUNTRIES.has(country) || !explicitOffsetTime(raw)) return null;
  const wall = partnerWall(raw, product, exportedLetter);
  if (!wall) return null;
  const zone = countryTimeZone(country);
  const placed = zone ? isoTime(wall, zone) : null;
  return placed ? { time: placed.iso } : { time: '', local_time: wall };
}
