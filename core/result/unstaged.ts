import { STAGES, type Stage } from '../../generated/catalog.js';
import { languageStageStatus } from '../status/index.js';
import type { CarrierEvent, CarrierResult } from './index.js';

const stages = new Set<string>(STAGES);

/**
 * The newest scan that has a stage, for a result that states none: a carrier can leave its
 * newest scans without one. Not a delivery or a return, which the scans after it may have undone.
 */
export function newestStagedScan(events: readonly CarrierEvent[]): CarrierEvent | null {
  let newest: CarrierEvent | null = null;
  let newestAt = -Infinity;
  for (const event of events) {
    const at = Date.parse(event.time ?? event.local_time ?? '');
    if (stages.has(event.stage ?? '') && at > newestAt) [newest, newestAt] = [event, at];
  }
  return newest?.stage === 'delivered' || newest?.stage === 'returned' ? null : newest;
}

/**
 * A result whose newest scan has no stage, as an adapter that reads its status from that scan alone
 * gives one, states neither status nor stage. It reads the newest scan with a stage instead, so one
 * new code does not blank the parcel. The scan without one keeps none, so its wording stays open.
 */
export function readNewestStage(result: CarrierResult): CarrierResult {
  if (result.status !== 'unknown' || result.current_stage !== undefined) return result;
  const scan = newestStagedScan(result.events ?? []);
  if (!scan) return result;
  const stage = scan.stage as Stage;
  return { ...result, status: languageStageStatus(stage), current_stage: stage,
    ...(typeof scan.stage_source === 'string' ? { current_stage_source: scan.stage_source } : {}) };
}
