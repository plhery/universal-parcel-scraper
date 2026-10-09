import type { CarrierId } from '../generated/catalog.js';

/**
 * Carriers that link a parcel but have no public page to type its number in.
 * A parcel whose number is hidden shows no link to them.
 */
export const carriersWithoutSearchPage: Partial<Record<CarrierId, string>> = {
  'amazon-logistics': 'Amazon shows its own deliveries only in the buyer\'s account; no public page takes the number',
  ciblex: 'Ciblex shows parcels only in its customer extranet, behind a sign-in',
};

/** Search pages the weekly check cannot open, and why. Each was seen working in a regular browser. */
export const uncheckedSearchPages: Partial<Record<CarrierId, string>> = {
  dtdc: 'www.dtdc.com refuses connections from many networks outside India; an archived phone-size copy shows its number field',
  'spee-dee': 'the tracking form is a frame from packages.speedeedelivery.com, which drops connections from many networks',
  'thailand-post': 'some of the tracker\'s servers stall on its script bundles, so the form often stays empty past the render window',
};
