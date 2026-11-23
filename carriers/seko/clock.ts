/** OmniParcel's own parcel numbers: GX and 17 or 18 digits. SEKO's tracking page does not know them. */
export const OMNIPARCEL_NUMBER = /^GX\d{17,18}$/;

/**
 * The clock OmniParcel's tracker shows when no zone is asked, "(UTC+10:00) Canberra, Melbourne, Sydney": +10:00 all
 * year, without Sydney's daylight saving, for every scan, those in Canada too. Brisbane keeps that clock. Universal
 * providers that copy the default page give its digits.
 */
export const OMNIPARCEL_DEFAULT_CLOCK = 'Australia/Brisbane';
