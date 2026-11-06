import { SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { allegroOnePickUpExpired, allegroOneStage } from './status.js';

export const ALLEGRO_TRACKING_MAX_ROWS = 300;
const MAX_ROWS = ALLEGRO_TRACKING_MAX_ROWS;
const MAX_EVENTS = 100;

interface Scan {
  readonly event: CarrierEvent & { time: string; description: string };
  readonly at: number;
  readonly index: number;
}

// The scans of a parcel on its way to a recipient again.
const ONWARD: ReadonlySet<string> = new Set(['out_for_delivery', 'failed_attempt', 'ready_for_pickup', 'delivered']);
// The scans that move a parcel, or say it reached someone.
const MOVING: ReadonlySet<string> = new Set(['accepted', 'in_transit', 'returned', ...ONWARD]);

/**
 * Whether a parcel taken back from its point goes to the sender. The first
 * later scan that says where it went, the return or a new delivery, decides;
 * until one does, the pick-up time having run out at the point does, since
 * Allegro sends such a parcel back.
 */
function takenBackToSender(later: readonly CarrierEvent[], expired: boolean): boolean {
  const next = later.find(({ stage }) => stage === 'returned' || (stage !== undefined && ONWARD.has(stage)));
  return next ? next.stage === 'returned' : expired;
}

function projectScan(row: unknown, index: number, provider: string, preserveClock: boolean): Scan {
  if (!isRecord(row) || typeof row.eventTimestamp !== 'string' || typeof row.description !== 'string') {
    throw new SchemaError(provider, `${provider} returned an invalid scan`);
  }
  const time = explicitOffsetTime(row.eventTimestamp);
  if (!time) throw new SchemaError(provider, `${provider} returned a scan without an offset time`);
  const description = clean(row.description, 300);
  if (!description) throw new SchemaError(provider, `${provider} returned a scan without wording`);
  const stage = allegroOneStage(description);
  return {
    event: { time: preserveClock ? row.eventTimestamp.trim() : time.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) },
    at: time.timestamp,
    index,
  };
}

/** The status-list history used by the separate Polish and Czech guest trackers. */
export function parseAllegroTrackingHistory(payload: unknown, provider: string, onEmpty: () => never, preserveClock = false): CarrierResult {
  if (!isRecord(payload) || !('status' in payload) || (payload.status !== null && !Array.isArray(payload.status))) {
    throw new SchemaError(provider, `${provider} returned an unexpected reply`);
  }
  const rows = (payload.status ?? []) as unknown[];
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, `${provider} returned an oversized history`);
  if (!rows.length) onEmpty();

  const seen = new Set<string>();
  const scans: Scan[] = [];
  rows.forEach((row, index) => {
    const scan = projectScan(row, index, provider, preserveClock);
    const key = `${preserveClock ? scan.at : scan.event.time}\n${scan.event.description}`;
    if (seen.has(key)) return;
    seen.add(key);
    scans.push(scan);
  });
  // The reply lists an older parcel's scans newest first and a newer one's
  // oldest first; the tracker shows them newest first. Instants order them,
  // and equal ones keep the order in which the reply logged them.
  const oldestFirst = scans.length > 1 && scans[0]!.at < scans.at(-1)!.at;
  scans.sort((left, right) => right.at - left.at || (oldestFirst ? right.index - left.index : left.index - right.index));
  // Once the parcel has waited at a point, a courier collecting it is the
  // uncollected parcel taken back, not the sender's drop-off accepted: a
  // return under way when it goes back to the sender, in transit when it goes
  // to a point or the door again. "Returned to the sender" sends it back: a
  // return under way while later scans still move it. Every later movement is
  // the way back, under way until its delivery reaches the sender.
  const chronological = scans.map((scan) => scan.event).reverse();
  let waited = false;
  let expired = false;
  let returning = false;
  chronological.forEach((event, index) => {
    if (waited && event.stage === 'accepted') {
      event.stage = takenBackToSender(chronological.slice(index + 1), expired) ? 'exception' : 'in_transit';
    }
    if (event.stage === 'returned') {
      if (chronological.slice(index + 1).some(({ stage }) => stage !== undefined && MOVING.has(stage))) event.stage = 'exception';
      returning = true;
    } else if (returning && event.stage && event.stage !== 'exception') {
      event.stage = event.stage === 'delivered' ? 'returned' : 'exception';
    }
    if (event.stage === 'ready_for_pickup') [waited, expired] = [true, false];
    if (allegroOnePickUpExpired(event.description)) expired = true;
  });
  const newest = scans[0]!.event;
  const current = newest.stage
    ? { stage: newest.stage as Stage, source: 'carrier_map' }
    : classifyWording(newest.description, 'in_transit');
  const stage = current.source !== 'none' ? current.stage : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.source } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: newest.time } : {}),
    events: scans.slice(0, MAX_EVENTS).map((scan) => scan.event),
    ...(scans.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}
