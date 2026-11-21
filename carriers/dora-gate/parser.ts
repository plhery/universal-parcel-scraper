import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { parseAnserxReply } from '../anserx/parser.js';
import { doraGateStage } from './status.js';

export const PROVIDER = 'Dora Gate';
export const CARRIER = 'dora-gate';
// DOR, ten digits and CN, as the public waybill.
const NUMBER = /^DOR\d{10}CN$/;

/** A Dora Gate waybill, without spaces or hyphens. Anything else is not a number it issues. */
export function normalizeDoraGateNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Dora Gate waybills are DOR, ten digits and CN');
  return number;
}

/**
 * The reply AnserX's tracker gives for a Dora Gate waybill, read as AnserX's
 * own: the shipment must be the whole number asked, AnserX's scans are on
 * Beijing time and the delivering carrier's relayed scans keep its clock.
 */
export function parseDoraGate(payload: unknown, raw: string): CarrierResult {
  return parseAnserxReply(payload, normalizeDoraGateNumber(raw), { provider: PROVIDER, stage: doraGateStage });
}
