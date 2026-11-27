import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { freightwaysQuery, parseFreightways, type FreightwaysNetwork, type FreightwaysQuery } from '../nz-couriers/freightways.js';

export const PROVIDER = 'Pass the Parcel';
// The Parcel Tracking Code on each pack and box: sixteen letters and digits,
// printed in four groups of four with dashes, which reach the adapter without
// them. Every code seen starts with 1RBB. The lookup's label loses its
// leading zeros, so a code cannot start with one.
const CODE = /^[1-9A-Z][A-Z0-9]{15}$/;
// Pass the Parcel sells packs and boxes, not courier tickets.
const NO_TICKET = /(?!)/;

/**
 * Pass the Parcel on the Freightways group's tracking lookup, under Post
 * Haste's name. Its parcels ride New Zealand Couriers and Post Haste, and the
 * one lookup shows the whole trip, so no scan names a delivery carrier.
 */
export const PASS_THE_PARCEL: FreightwaysNetwork = {
  carrier: 'pass-the-parcel', provider: PROVIDER, path: 'PostHaste', ticket: NO_TICKET, label: CODE,
  numbers: 'sixteen-character Parcel Tracking Codes', namesDeliveryCarrier: false,
};

/**
 * A Parcel Tracking Code as the lookup takes it. Anything else, such as a
 * Post Haste ticket, SSCC or customer printed label, is invalid input.
 */
export function passTheParcelQuery(raw: string): FreightwaysQuery {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!CODE.test(number)) throw new InvalidInputError(PROVIDER, `${PROVIDER} numbers are ${PASS_THE_PARCEL.numbers}`);
  return freightwaysQuery(PASS_THE_PARCEL, number);
}

/**
 * The lookup's reply for one code, read as Post Haste's is: the consignment
 * must name the whole code asked, and its scans are kept newest first.
 */
export function parsePassTheParcel(payload: unknown, raw: string): CarrierResult {
  passTheParcelQuery(raw);
  return parseFreightways(PASS_THE_PARCEL, payload, raw);
}
