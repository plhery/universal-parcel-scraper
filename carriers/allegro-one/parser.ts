import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError, NotFoundError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { ALLEGRO_TRACKING_MAX_BYTES } from './client.js';
import { parseAllegroTrackingHistory } from './history.js';

export const PROVIDER = 'Allegro One';
// A parcel's reply is a list of short scans; a few kilobytes.
export const ALLEGRO_ONE_MAX_BYTES = ALLEGRO_TRACKING_MAX_BYTES;
// Allegro One's ten-character numbers start A0. Allegro Delivery's start AD and
// have seventeen characters; earlier ones, and some returns, have ten like
// Allegro One's. The older form the tracker still answers is ALE and twelve digits.
const NUMBER = /^(?:A[0D][0-9A-Z]{8}|AD[0-9A-Z]{15}|ALE\d{12})$/;

/** An Allegro One number; anything else is a number Allegro One does not issue. */
export function normalizeAllegroOneNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Allegro One numbers are A0 or AD and eight letters and digits, AD and fifteen, or ALE and twelve digits');
  }
  return number;
}

/** Polish Allegro labels keep their existing absence and older-label retention policy. */
export function parseAllegroOne(payload: unknown, raw: string): CarrierResult {
  const number = normalizeAllegroOneNumber(raw);
  return parseAllegroTrackingHistory(payload, PROVIDER, () => {
    if (number.startsWith('ALE')) throw new NoHistoryError(PROVIDER, 'Allegro One has no scans for this number');
    throw new NotFoundError(PROVIDER);
  });
}
