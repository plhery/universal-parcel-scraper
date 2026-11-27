import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { ITDIDA_MAX_BYTES, parseItdida, type ItdidaTenant } from './itdida.js';
import { statusMap, whwdtStage } from './status.js';

export const PROVIDER = 'Wuhan Wodetong';
export const CARRIER = 'whwdt';
export const WHWDT_MAX_BYTES = ITDIDA_MAX_BYTES;
/** The ITDIDA tenant the forwarder's site links to for order lookups. */
export const WHWDT_HOST = 'hyd.itdida.com';
// The forwarder's waybills seen so far: a letter, twelve digits and a letter.
const NUMBER = /^[A-Z]\d{12}[A-Z]$/;

/** A Wodetong waybill, without spaces or hyphens. Anything else is not a number its tenant issues. */
export function normalizeWhwdtNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Wuhan Wodetong waybills are a letter, twelve digits and a letter');
  return number;
}

/**
 * The forwarder's ITDIDA tenant. Its scans come from the warehouse in
 * Shenzhen, the line haul and the delivering carrier, each in its own place's
 * wall clock.
 */
export const WHWDT: ItdidaTenant = {
  carrier: CARRIER, provider: PROVIDER, host: WHWDT_HOST, normalize: normalizeWhwdtNumber,
  stage: (wording) => whwdtStage(wording), statusMap,
};

/** The reply of the tenant's `queryTracks` lookup. */
export function parseWhwdt(payload: unknown, raw: string): CarrierResult {
  return parseItdida(WHWDT, payload, raw);
}
