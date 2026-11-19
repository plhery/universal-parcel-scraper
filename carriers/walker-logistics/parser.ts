import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

export const PROVIDER = 'Walker Logistics';

const stages = new Map<string, Stage>([
  ['Manifested', 'registered'],
  ['Pickup', 'accepted'],
  ['In Depot', 'in_transit'],
  ['Out For Delivery', 'out_for_delivery'],
  ['Delivery', 'delivered'],
]);

export function parseWalkerLogistics(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload) || typeof payload.consignmentFound !== 'boolean' || typeof payload.itemFound !== 'boolean'
      || typeof payload.searchStr !== 'string') throw new SchemaError(PROVIDER, 'Invalid Tempo tracking reply');
  const requested = number.toUpperCase();
  if (payload.searchStr.toUpperCase() !== requested) throw new IndeterminateError(PROVIDER, 'Reply is for another lookup');
  if (!payload.consignmentFound && !payload.itemFound && payload.conNoteId === null && payload.eventResults === null) {
    throw new NotFoundError(PROVIDER);
  }
  if (!payload.consignmentFound || typeof payload.conNoteId !== 'string' || payload.conNoteId.trim().toUpperCase() !== requested) {
    throw new IndeterminateError(PROVIDER, 'Reply does not identify the requested consignment');
  }
  if (payload.eventResults === null) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(payload.eventResults) || payload.eventResults.length > 500) throw new SchemaError(PROVIDER, 'Invalid Tempo history');
  const history = payload.eventResults.map((row: unknown) => {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Invalid Tempo event');
    const clock = explicitOffsetTime(row.finished);
    const type = clean(row.eventTypeName, 120);
    if (!clock || !type || !Number.isSafeInteger(row.eventOutcomeId)) throw new SchemaError(PROVIDER, 'Invalid dated Tempo event');
    const stage = row.eventOutcomeId === 0 || (type === 'Out For Delivery' && row.eventOutcomeId === 1)
      ? stages.get(type) : undefined;
    const reason = clean(row.reasonName, 160);
    const outcome = row.eventOutcomeId === 0 ? '' : clean(row.eventOutcome, 80);
    const location = clean(row.location, 120);
    return { timestamp: clock.timestamp, event: {
      time: clock.iso, description: [type, outcome, reason].filter(Boolean).join(' — '),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    } };
  });
  if (!history.length) throw new NoHistoryError(PROVIDER);
  const events = history.sort((a, b) => b.timestamp - a.timestamp).map(scan => scan.event);
  const latest = events[0]!;
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description,
    last_update: latest.time,
    expected_delivery: null,
    ...(latest.stage === 'delivered' ? { delivered_at: latest.time } : {}),
    events,
  };
}
