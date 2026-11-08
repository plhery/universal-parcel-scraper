import { STAGES, type Stage } from '../../generated/catalog.js';
import { languageStageStatus } from '../status/index.js';
import type { CarrierEvent, CarrierResult } from './index.js';
import { listsNewestFirst, scanTime } from './order.js';

const stages = new Set<string>(STAGES);

/**
 * The newest scan that has a stage, for a result that states none: a carrier can leave its
 * newest scans without one. Not a delivery or a return, which the scans after it may have undone.
 * Instants compare with instants and wall clocks with wall clocks, whatever the host's zone;
 * between the newest of each, the answer's order decides, newest first unless its scans show it
 * lists them oldest first.
 */
export function newestStagedScan(events: readonly CarrierEvent[]): CarrierEvent | null {
  const newest = new Map<boolean, { index: number; at: number }>();
  events.forEach((event, index) => {
    const time = stages.has(event.stage ?? '') ? scanTime(event) : null;
    if (time === null) return;
    const held = newest.get(time.wall);
    if (!held || time.at > held.at) newest.set(time.wall, { index, at: time.at });
  });
  const indexes = [...newest.values()].map(({ index }) => index);
  if (indexes.length === 0) return null;
  const scan = events[listsNewestFirst(events) === false ? Math.max(...indexes) : Math.min(...indexes)]!;
  return scan.stage === 'delivered' || scan.stage === 'returned' ? null : scan;
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
