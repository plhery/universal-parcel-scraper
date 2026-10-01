import { STAGES, type Stage } from '../../generated/catalog.js';
import { classifyWording } from '../status/index.js';
import { explicitOffsetTime } from '../time/index.js';
import { normalizeCarrierResult, type CarrierEvent, type CarrierResult } from './index.js';

const stages = new Set<string>(STAGES);

export function resultStage(result: CarrierResult): Stage | null {
  if (stages.has(result.current_stage ?? '')) return result.current_stage as Stage;
  const fallback: Partial<Record<NonNullable<CarrierResult['status']>, Stage>> = {
    pending: 'pending', in_transit: 'in_transit', out_for_delivery: 'out_for_delivery',
    delivered: 'delivered', exception: 'failed_attempt',
  };
  const base = fallback[result.status ?? 'unknown'];
  return base ? classifyWording(result.last_status_text ?? '', base).stage : null;
}

export function resultHasUpdate(result: CarrierResult): boolean {
  const stage = resultStage(result);
  return Boolean(stage && stage !== 'pending') || (result.events ?? []).some(event => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    return (declared ?? classifyWording(event.description ?? '', 'pending').stage) !== 'pending';
  });
}

export interface ResolvedEvent extends CarrierEvent {
  stage: Stage;
  stage_source: string;
  /** Null for a date or local clock whose offset the feed did not establish. */
  instant: string | null;
}

export interface ResolvedResult extends CarrierResult {
  events: ResolvedEvent[];
}

/** Classify wording and expose verified instants while retaining the feed's clocks. */
export function resolveResult(input: unknown): ResolvedResult {
  const result = normalizeCarrierResult(input);
  const current = resultStage(result);
  const events = (result.events ?? []).map((event): ResolvedEvent => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    const classified = classifyWording(event.description ?? '', 'in_transit');
    return { ...event, stage: declared ?? classified.stage,
      stage_source: declared ? 'carrier_map' : classified.source,
      instant: explicitOffsetTime(event.time)?.iso ?? null };
  });
  return { ...result, ...(current ? { current_stage: current } : {}), events };
}
