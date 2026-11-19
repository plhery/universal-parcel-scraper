import { STAGES, type Stage } from '../../generated/catalog.js';
import { languageStageStatus } from '../status/index.js';
import { normalizeStatusWording, statusGapNote, type CarrierStatusMap } from '../status/statusMap.js';
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
  const oldestFirst = listsNewestFirst(events) === false;
  const newest = new Map<boolean, { index: number; at: number }>();
  events.forEach((event, index) => {
    const time = stages.has(event.stage ?? '') ? scanTime(event) : null;
    if (time === null) return;
    const held = newest.get(time.wall);
    if (!held || time.at > held.at || (oldestFirst && time.at === held.at)) newest.set(time.wall, { index, at: time.at });
  });
  const indexes = [...newest.values()].map(({ index }) => index);
  if (indexes.length === 0) return null;
  const scan = events[oldestFirst ? Math.max(...indexes) : Math.min(...indexes)]!;
  return scan.stage === 'delivered' || scan.stage === 'returned' ? null : scan;
}

/**
 * Whether a carrier's map says a scan moves nothing: it maps it as pending, or leaves it without a
 * stage on purpose (`statusGapNote`), as a notice that keeps the stage of the scan before it.
 */
export function movesNothing(event: CarrierEvent, map: CarrierStatusMap): boolean {
  if (event.stage) return event.stage === 'pending';
  const wording = normalizeStatusWording(event.description ?? '');
  return wording !== '' && statusGapNote(map, event.provider_code ?? null, wording) !== undefined;
}

/**
 * The scan that sets the stage, of a carrier's scans newest first: the newest, when it has a stage,
 * else the newest staged scan no newer scan may have undone (`newestStagedScan`), so a newer scan
 * without a stage undoes a delivery. A notice the carrier's map says moves nothing (`movesNothing`)
 * is passed over and a delivery stands under it; with only such notices, the newest staged one leads.
 */
export function leadingScan(newestFirst: readonly CarrierEvent[], map: CarrierStatusMap): CarrierEvent | undefined {
  const moving = newestFirst.filter((event) => !movesNothing(event, map));
  const lead = moving[0];
  if (!lead) return newestFirst.find((event) => event.stage);
  return lead.stage ? lead : newestStagedScan(moving) ?? undefined;
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
