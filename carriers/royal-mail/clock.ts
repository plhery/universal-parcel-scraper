import { countryTimeZone } from '../../core/time/index.js';

/**
 * The clock of a European partner's scans abroad: they reach Royal Mail on
 * Central European time, whatever the country's own clock, and Royal Mail
 * labels that wall clock with the UK's offset.
 */
export const ROYAL_MAIL_RELAY_CLOCK = 'Europe/Brussels';

/** The UK and the Crown Dependencies, which keep the UK's clock. */
export const ROYAL_MAIL_HOME: ReadonlySet<string> = new Set(['GB', 'JE', 'GG', 'IM']);

const IN_DESTINATION = /\bin the destination country\b/i;
// Royal Mail's own facilities go by bare names: "Example MC", "Example DO", "LANGLEY HWDC".
const HOME_FACILITY = /\b(?:MC|DO|HWDC|IMC|LC|DC|PFW|Mail Centre|Delivery Office|Hub|Depot)\b/i;

/** A European country other than the UK and the Crown Dependencies. */
export const europeanAbroad = (country: string | null): boolean => Boolean(country && !ROYAL_MAIL_HOME.has(country)
  && countryTimeZone(country)?.startsWith('Europe/'));

/** Whether a place names no country and is a partner's, not shaped like Royal Mail's own facilities. */
export const partnerPlace = (location: string): boolean => !location || !HOME_FACILITY.test(location);

/**
 * Whether a scan whose place names no country relays a European partner's
 * clock because Royal Mail's words put it in the destination ("Your item is
 * currently with Customs in the destination country"): its place is a
 * partner's bare facility name, or it has none, and the parcel goes to a
 * European country abroad.
 */
export const destinationRelay = (location: string, description: string, destination: string | null): boolean =>
  partnerPlace(location) && europeanAbroad(destination) && IN_DESTINATION.test(description);
