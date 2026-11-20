import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { shipmentStatus } from './status.js';

export const provider = 'sky-courier-co';

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Sky Courier requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Sky Courier did not return tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.error === 'Package not found') {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(reply) || reply.success !== true || !Array.isArray(reply.packages)) {
    throw new SchemaError(provider, 'Sky Courier did not return its shipment list');
  }
  const exact = reply.packages.filter(parcel => isRecord(parcel) && parcel.skyTrackingNumber === number);
  if (exact.length !== 1) {
    throw new IndeterminateError(provider, 'Sky Courier did not identify one shipment with the requested guide number');
  }
  const parcel: unknown = exact[0];
  if (!isRecord(parcel) || typeof parcel.status !== 'string' || !parcel.status.trim()) {
    throw new IndeterminateError(provider, 'Sky Courier listed the guide without a shipment status', { reason: 'listed' });
  }

  const code = parcel.status.trim();
  const status = shipmentStatus(code);
  return {
    status: status ? languageStageStatus(status.stage) : 'unknown',
    ...(status && { current_stage: status.stage, current_stage_source: 'carrier_map' }),
    last_status_text: status?.description ?? code,
    provider_code: code,
    summary_only: true,
    events: [],
  };
}
