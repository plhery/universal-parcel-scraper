import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTrackingByNos, type TrackingByNosCarrier } from '../cttyex/parser.js';
import { DONGDU_NOT_FOUND, dongduMappedStage, dongduStage } from './status.js';

export const PROVIDER = 'Dongdu';
// One parcel's reply is about a kilobyte.
export const DONGDU_MAX_BYTES = 256 * 1024;
// No public page shows a Dongdu number, so the rule is the system's: letters and digits, one digit at least.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;

/** A number for Dongdu's tracker, in capitals. */
export function normalizeDongduNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dongdu numbers are eight or more letters and digits');
  return number;
}

const DONGDU: TrackingByNosCarrier = { provider: PROVIDER, normalize: normalizeDongduNumber, stage: dongduStage,
  summaryStage: dongduMappedStage, notFound: DONGDU_NOT_FOUND };

/** Dongdu's reply for one number, which its tracker, CTTYEX's system, gives in CTTYEX's form. */
export const parseDongdu = (payload: unknown, raw: string): CarrierResult => parseTrackingByNos(payload, raw, DONGDU);
