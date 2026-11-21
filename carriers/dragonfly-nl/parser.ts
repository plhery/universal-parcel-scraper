import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { parseDragonflyTracking, type DragonflyService } from '../intelcom/parser.js';
import { dragonflyNlCodeStage } from './status.js';

const PROVIDER = 'Dragonfly Netherlands';
// The Dutch tracking page lists no client it names, so the adapter names none.
const SERVICE: DragonflyService = { provider: PROVIDER, name: PROVIDER, codeStage: dragonflyNlCodeStage, clients: {} };

export function normalizeDragonflyNlNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Dragonfly Netherlands requires an alphanumeric tracking number');
  return number;
}

export function parseDragonflyNl(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeDragonflyNlNumber(rawNumber);
  const result = isRecord(payload) && isRecord(payload.data) ? payload.data.result : undefined;
  // The reply names its national network; another network's parcel is not this carrier's.
  if (isRecord(result) && result.subsidiary !== undefined && result.subsidiary !== 'dragonfly_nl') {
    throw new SchemaError(PROVIDER, 'Dragonfly Netherlands returned another network\'s shipment');
  }
  return parseDragonflyTracking(payload, number, SERVICE);
}
