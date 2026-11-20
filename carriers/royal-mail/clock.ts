import { DateTime } from 'luxon';
import { countryCode, countryTimeZone, firstOccurrence } from '../../core/time/index.js';

import { locatePlace } from '../../places/index.js';

/**
 * The clock of a European partner's scan abroad, whatever the country's own
 * clock, which Royal Mail labels with the UK's offset. Its digits run twice the
 * UK's offset ahead of UTC: on British Summer Time they are Central European
 * time, as the destination posts' own scans show, and on Greenwich Mean Time they
 * are UTC, as La Poste's, Poste Italiane's and Poczta Polska's own scans of the
 * same items show to the minute.
 */
export function royalMailRelayClock(wall: string): string {
  return firstOccurrence(DateTime.fromISO(wall, { zone: 'Europe/London' })).offset ? 'Europe/Brussels' : 'Europe/London';
}

/**
 * The offset Royal Mail labels a partner office's wall clock with in a country of several clocks,
 * one per country wherever the office is. Australia's is central Australia's standard time:
 * Australia Post dates the same scans 30 minutes earlier in Brisbane and 1 h 30 earlier in
 * Sydney's summer. The United States' is Eastern standard time, all year: USPS dates the same
 * scans at its international service centre in Los Angeles three hours earlier, the receipt at
 * 07:39 that Royal Mail gives at 12:39 UK time, and the customs release at 19:04 that it gives at
 * 00:04; in October, an hour earlier at an office in Kentucky, on Eastern daylight time.
 */
const PARTNER_LABELS: Readonly<Record<string, string>> = { AU: 'UTC+9:30', US: 'UTC-5' };

// A USPS facility, which Royal Mail names with or without its country: "ISC EXAMPLE CITY CA (USPS)".
const USPS_FACILITY = /\(USPS\)\s*(?:,|$)/i;

/** Whether Royal Mail labels a country's partner offices with one offset (`PARTNER_LABELS`). */
export const royalMailLabelsPartners = (country: string | null): country is string => Boolean(country && Object.hasOwn(PARTNER_LABELS, country));

/** The country of a place whose partner offices Royal Mail labels with one offset, or null. */
export function royalMailPartnerCountry(location: string): string | null {
  const country = countryCode(/(?:^|,)\s*([^,]+)$/.exec(location)?.[1]) ?? (USPS_FACILITY.test(location) ? 'US' : null);
  return royalMailLabelsPartners(country) ? country : null;
}

/**
 * The partner office's wall clock of a Royal Mail scan in `country`, from the instant Royal Mail's
 * label gives, or null for a country whose offices it labels otherwise.
 */
export function royalMailPartnerWall(country: string | null, instant: DateTime): string | null {
  return royalMailLabelsPartners(country) && instant.isValid ? instant.setZone(PARTNER_LABELS[country]).toFormat("yyyy-MM-dd'T'HH:mm:ss") : null;
}

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
export const destinationRelay = (location: string, description: string, destination: string | null): boolean => {
  if (!europeanAbroad(destination) || !IN_DESTINATION.test(description)) return false;
  if (partnerPlace(location)) return true;
  const town = /^(.+?)\s+(?:Hub|Depot)$/i.exec(location)?.[1];
  const place = town ? locatePlace(town) : null;
  return place?.precision === 'city' && place.country === destination;
};
