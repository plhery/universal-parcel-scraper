import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseTrackingByNos, type TrackingByNosCarrier } from '../cttyex/parser.js';
import { ZECHENG_NOT_FOUND, zechengMappedStage, zechengStage } from './status.js';

export const PROVIDER = 'Zecheng';
// One parcel's reply is about a kilobyte.
export const ZECHENG_MAX_BYTES = 256 * 1024;
// No public page shows a Zecheng number, so the rule is the system's: letters and digits, one digit at least.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{8,40}$/;

/** A number for Zecheng's tracker, in capitals. */
export function normalizeZechengNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw).toUpperCase() : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Zecheng numbers are eight or more letters and digits');
  return number;
}

const ZECHENG: TrackingByNosCarrier = { provider: PROVIDER, normalize: normalizeZechengNumber, stage: zechengStage,
  summaryStage: zechengMappedStage, notFound: ZECHENG_NOT_FOUND };

/** Zecheng's reply for one number, which its tracker, CTTYEX's system, gives in CTTYEX's form. */
export const parseZecheng = (payload: unknown, raw: string): CarrierResult => parseTrackingByNos(payload, raw, ZECHENG);
