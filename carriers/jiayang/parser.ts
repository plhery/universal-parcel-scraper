import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTrackingByNos, type TrackingByNosCarrier } from '../cttyex/parser.js';
import { JIAYANG_NOT_FOUND, jiayangMappedStage, jiayangStage } from './status.js';

export const PROVIDER = 'Jiayang';
// One parcel's reply is about two kilobytes.
export const JIAYANG_MAX_BYTES = 256 * 1024;
// No public page shows a Jiayang number, so the rule is the system's: letters and digits, one digit at least.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;

/** A number for Jiayang's tracker, in capitals. */
export function normalizeJiayangNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Jiayang numbers are eight or more letters and digits');
  return number;
}

const JIAYANG: TrackingByNosCarrier = { provider: PROVIDER, normalize: normalizeJiayangNumber, stage: jiayangStage,
  summaryStage: jiayangMappedStage, notFound: JIAYANG_NOT_FOUND };

/** Jiayang's reply for one number, which its tracker, CTTYEX's system, gives in CTTYEX's form. */
export const parseJiayang = (payload: unknown, raw: string): CarrierResult => parseTrackingByNos(payload, raw, JIAYANG);
