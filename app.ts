/**
 * Helpers shaped for the parcel app this package was extracted from: its
 * parcel view, carrier-name hints for provider results, the clock helpers
 * its sync uses, and the country a scan's location names. They change with
 * that app and carry no stability promise; the tracking contract is the
 * other entry points.
 */
export * from './core/catalog/parcel.js';
export * from './core/catalog/hints.js';
export * from './core/time/result.js';
export { universalCarrierHints } from './providers/shared/hints.js';
export { recognitionAskedCarriers } from './core/catalog/recognition.js';
export { countryFlag, countryName, trackingLocationCountry, trackingPlace, type TrackingPlace } from './places/trackingLocation.js';
