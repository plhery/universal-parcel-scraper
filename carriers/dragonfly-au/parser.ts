import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { parseDragonflyTracking, type DragonflyService } from '../intelcom/parser.js';
import { dragonflyAuCodeStage } from './status.js';

const PROVIDER = 'Dragonfly Australia';
// The Australian tracking page names no client, so the adapter names none.
const SERVICE: DragonflyService = { provider: PROVIDER, name: PROVIDER, codeStage: dragonflyAuCodeStage, clients: {} };

export function normalizeDragonflyAuNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Dragonfly Australia requires an alphanumeric tracking number');
  return number;
}

export function parseDragonflyAu(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDragonflyAuNumber(rawNumber);
  const result = isRecord(payload) && isRecord(payload.data) ? payload.data.result : undefined;
  // The reply names its national network; another network's parcel is not this carrier's.
  if (isRecord(result) && result.subsidiary !== undefined && result.subsidiary !== 'dragonfly_au') {
    throw new SchemaError(PROVIDER, 'Dragonfly Australia returned another network\'s shipment');
  }
  return parseDragonflyTracking(payload, number, SERVICE);
}
