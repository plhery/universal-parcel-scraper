import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
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
// The sender's side: a pickup or manifest that did not succeed is no attempt to deliver.
const SENDER_STEPS = new Set(['Manifested', 'Pickup']);

/**
 * A scan's stage: the map for a successful step, else the shared wording rules on the whole
 * description ("Delivery — Failed — No One Home"), which leave an unread outcome without one.
 */
function scanStage(type: string, outcome: number, description: string): ClassifiedWording | null {
  const mapped = outcome === 0 || (type === 'Out For Delivery' && outcome === 1) ? stages.get(type) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  if (SENDER_STEPS.has(type)) return null;
  const worded = classifyWording(description, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

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
    const outcomeId = row.eventOutcomeId;
    if (!clock || !type || typeof outcomeId !== 'number' || !Number.isSafeInteger(outcomeId)) throw new SchemaError(PROVIDER, 'Invalid dated Tempo event');
    const reason = clean(row.reasonName, 160);
    const outcome = outcomeId === 0 ? '' : clean(row.eventOutcome, 80);
    const location = clean(row.location, 120);
    const description = [type, outcome, reason].filter(Boolean).join(' — ');
    const stage = scanStage(type, outcomeId, description);
    return { timestamp: clock.timestamp, event: {
      time: clock.iso, description,
      ...(location ? { location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
    } };
  });
  if (!history.length) throw new NoHistoryError(PROVIDER);
  const events = history.sort((a, b) => b.timestamp - a.timestamp).map(scan => scan.event);
  const latest = events[0]!;
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description,
    last_update: latest.time,
    expected_delivery: null,
    ...(latest.stage === 'delivered' ? { delivered_at: latest.time } : {}),
    events,
  };
}
