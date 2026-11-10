import { STAGES, type Stage } from '../../generated/catalog.js';
import { classifyWording } from '../status/index.js';
import { explicitOffsetTime } from '../time/index.js';
import { normalizeCarrierResult, type CarrierEvent, type CarrierResult } from './index.js';
import { readLateRegistrations } from './registration.js';
import { newestStagedScan } from './unstaged.js';

const stages = new Set<string>(STAGES);

export function resultStage(result: CarrierResult): Stage | null {
  if (stages.has(result.current_stage ?? '')) return result.current_stage as Stage;
  const fallback: Partial<Record<NonNullable<CarrierResult['status']>, Stage>> = {
    pending: 'pending', in_transit: 'in_transit', out_for_delivery: 'out_for_delivery',
    delivered: 'delivered', exception: 'failed_attempt',
  };
  const base = fallback[result.status ?? 'unknown'];
  if (!base) return (newestStagedScan(result.events ?? [])?.stage as Stage | undefined) ?? null;
  const stage = classifyWording(result.last_status_text ?? '', base).stage;
  const first = result.events?.[0]?.stage;
  return stage === 'pending' && stages.has(first ?? '') ? first as Stage : stage;
}

export function resultHasUpdate(result: CarrierResult): boolean {
  const stage = resultStage(result);
  return Boolean(stage && stage !== 'pending') || (result.events ?? []).some(event => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    return Boolean(declared && declared !== 'pending')
      || Boolean(event.description && classifyWording(event.description, 'pending').stage !== 'pending');
  });
}

export function classifyStage(text: string, fallback = 'in_transit') {
  return classifyWording(text, fallback as Stage);
}

export function inferStage(text: string, fallback = 'in_transit'): string {
  return classifyStage(text, fallback).stage;
}

export function stageSource(declaredStage: string, description: string, source?: unknown): string {
  if (!stages.has(declaredStage)) return classifyStage(description).source;
  if (typeof source === 'string' && source.length <= 100
    && (source === 'none' || source === 'carrier_map' || /^wording:[a-z0-9_]+$/.test(source))) return source;
  return 'carrier_map';
}

export interface ResolvedEvent extends CarrierEvent {
  stage: Stage;
  stage_source: string;
  /** Null for a date or local clock whose offset the feed did not establish. */
  instant: string | null;
  /**
   * Set when the adapter left the scan without a stage and the shared wording classifier gave it
   * one, its rule or its fallback. Absent on a stage the adapter chose, by any map or rule.
   */
  stage_inferred?: true;
}

export interface ResolvedResult extends CarrierResult {
  events: ResolvedEvent[];
}

/** Classify wording and expose verified instants while retaining the feed's clocks. */
export function resolveResult(input: unknown): ResolvedResult {
  const result = readLateRegistrations(normalizeCarrierResult(input));
  const current = resultStage(result);
  const events = (result.events ?? []).map(({ stage_inferred: marked, ...event }): ResolvedEvent => {
    const declared = stages.has(event.stage ?? '') ? event.stage as Stage : undefined;
    const classified = classifyWording(event.description ?? '', 'in_transit');
    // A lookup resolves an answer again once it merges it: a scan staged here before keeps its mark
    // while it still holds the classifier's stage and source.
    const inferred = !declared || (marked === true && declared === classified.stage && event.stage_source === classified.source);
    return { ...event, stage: declared ?? classified.stage,
      stage_source: declared ? stageSource(declared, event.description ?? '', event.stage_source) : classified.source,
      instant: explicitOffsetTime(event.time)?.iso ?? null, ...(inferred ? { stage_inferred: true as const } : {}) };
  });
  return { ...result, ...(current ? { current_stage: current } : {}), events };
}
