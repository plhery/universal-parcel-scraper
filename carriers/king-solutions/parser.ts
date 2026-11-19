import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';

export const PROVIDER = 'King Solutions';
const stages = new Map<string, Stage>([['Enroute', 'in_transit'], ['Delivered', 'delivered']]);

function instant(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 8.64e15) throw new SchemaError(PROVIDER, 'Invalid trace date');
  return new Date(value).toISOString();
}

export function parseReply(body: string, number: string): CarrierResult {
  let data: unknown;
  try { data = JSON.parse(body); } catch { throw new SchemaError(PROVIDER, 'Invalid tracking response'); }
  if (!isRecord(data) || !Array.isArray(data.trackResults) || !Array.isArray(data.unknownPros) || !Array.isArray(data.erroneousPros)) throw new SchemaError(PROVIDER, 'Missing PRO results');
  if (!data.trackResults.length && !data.erroneousPros.length && data.unknownPros.length === 1 && data.unknownPros[0] === number) throw new NotFoundError(PROVIDER);
  const result: unknown = data.trackResults[0];
  if (data.trackResults.length !== 1 || !isRecord(result) || !isRecord(result.trackItem)) throw new IndeterminateError(PROVIDER, 'Expected one matched shipment');
  const item = result.trackItem;
  if (result.searchString !== number || result.proNum !== item.proNumber || (item.proNumber !== number && item.carrierProNum !== number)) throw new IndeterminateError(PROVIDER, 'PRO mismatch');
  if (typeof item.status !== 'string' || !item.status.trim() || !Array.isArray(result.externalNotes)) throw new SchemaError(PROVIDER, 'Incomplete shipment');
  const stage = stages.get(item.status);
  let omitted = false;
  const events: CarrierEvent[] = result.externalNotes.flatMap((note: unknown) => {
    if (!isRecord(note) || typeof note.comments !== 'string' || !note.comments.trim()) throw new SchemaError(PROVIDER, 'Invalid trace note');
    // The notes are written by hand: one naming who signed, or a code, costs only its own row.
    if (hasPrivateDeliveryDetails(note.comments)) { omitted = true; return []; }
    const noteStage = typeof note.traceStatus === 'string' ? stages.get(note.traceStatus) : undefined;
    return [{ time: instant(note.traceDate), description: note.comments.trim(), ...(noteStage ? { stage: noteStage, stage_source: 'carrier_map' } : {}) }];
  });
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const delivery = stage === 'delivered' && item.actualDeliveryDate ? instant(item.actualDeliveryDate) : undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: item.status, last_update: [delivery, events[0]?.time].filter(Boolean).sort().at(-1) ?? null, expected_delivery: null,
    ...(delivery ? { delivered_at: delivery } : {}), ...(!events.length ? { summary_only: true } : {}), ...(omitted ? { history_truncated: true } : {}), events };
}
