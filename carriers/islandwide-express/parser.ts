import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { windowEstimate, type WindowEstimate } from '../../core/result/window.js';
import { classifyWording, languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay, isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { islandwideCodeStage, islandwideStatusText } from './status.js';

export const PROVIDER = 'Islandwide Express';
/** Puerto Rico's clock, on which the tracker writes every time. It keeps no daylight saving time. */
export const ISLANDWIDE_ZONE = 'America/Puerto_Rico';

// The tracker's list of formats runs from eight to 34 letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,40}$/;
// "04/28/2026 12:40:39": the month, the day, the year and a wall clock to the second, with no zone.
const CLOCK = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
// The tracker writes a date it does not have as nothing or as the first day of 1900.
const NO_DATE = /^(?:\d{2}\/\d{2}\/1900 00:00:00)?$/;
const CODE = /^\d{1,4}$/;
// A terminal's lines, town and ZIP code, then PR. The label's row has none, written "  ,  ".
const TERMINAL = /^\S.*, \d{5} PR$/;
// The page places a pickup at the sender's address and a delivery at the recipient's, not at the
// terminal the row also names.
const AT_CUSTOMER = new Set(['3', '10', '13']);
const MAX_ROWS = 300;

/** A number for Islandwide's tracker. */
export function normalizeIslandwideNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Islandwide numbers are 6 to 40 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Whether the tracker says the request named an older build of its page, or of the action. */
export function versionChanged(payload: unknown): boolean {
  const info = isRecord(payload) ? payload.versionInfo : undefined;
  return isRecord(info) && (info.hasModuleVersionChanged === true || info.hasApiVersionChanged === true);
}

/** A time as the tracker writes it, as an ISO wall clock, or null when it has none or it does not read. */
function wallClock(value: unknown): string | null {
  const parts = CLOCK.exec(clean(value, 40));
  const date = parts ? calendarDay(Number(parts[3]), Number(parts[1]), Number(parts[2])) : null;
  if (!parts || !date || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  return `${date}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

type Scan = CarrierEvent & { local_time: string; time: string; description: string };

/**
 * A wall clock dated on Puerto Rico's clock. The tracker writes no zone, and Islandwide's terminals
 * are all on the island.
 */
function dated(local: string): Pick<Scan, 'local_time' | 'time' | 'time_zone' | 'time_zone_basis'> {
  const time = isoTime(local, ISLANDWIDE_ZONE)?.iso ?? invalid('Islandwide returned an invalid time');
  return { local_time: local, time, time_zone: ISLANDWIDE_ZONE, time_zone_basis: 'carrier' };
}

/** A state id's stage from the map, else a wording's from the shared rules, else nothing. */
function stageOf(code: string, wording: string): ClassifiedWording | null {
  const mapped = code ? islandwideCodeStage(code) : undefined;
  if (mapped) return { stage: mapped, source: 'carrier_map' };
  const worded = classifyWording(wording, 'in_transit');
  return worded.source === 'none' ? null : worded;
}

/**
 * The shipment's history, oldest first in the reply. A row's wording is the other carrier's
 * description when it has one, else the tracker's label for the state. Its place is the terminal it
 * names, except where the page shows a customer's address instead. The coordinates, the addresses,
 * the driver's and the user's ids, the signer and the signature are not read.
 */
function scansOf(shipment: JsonObject): Scan[] {
  const history = isRecord(shipment.TrackingHistory) ? shipment.TrackingHistory.List : undefined;
  if (!Array.isArray(history)) return invalid('Islandwide returned a shipment without its history');
  if (history.length > MAX_ROWS) return invalid('Islandwide returned an oversized history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const row of history) {
    if (!isRecord(row) || typeof row.StatusDateTime !== 'string') return invalid('Islandwide returned a changed history row');
    if (NO_DATE.test(clean(row.StatusDateTime, 40))) continue;
    const local = wallClock(row.StatusDateTime) ?? invalid('Islandwide returned an invalid time');
    const code = clean(row.Status, 8);
    if (code && !CODE.test(code)) return invalid('Islandwide returned an invalid state');
    const relayed = clean(row.CarrierStatusDescription, 200);
    const description = relayed || clean(row.LabelState, 200) || (code ? islandwideStatusText(code) : undefined)
      || invalid('Islandwide returned a scan without its state');
    const terminal = clean(row.TerminalDirection, 200);
    const location = !relayed && !AT_CUSTOMER.has(code) && TERMINAL.test(terminal) ? terminal : undefined;
    const key = JSON.stringify([local, code, description, location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = stageOf(code, description);
    scans.push({ ...dated(local), description, ...(code ? { provider_code: code } : {}), ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // Newest first; scans of one second keep the reply's order, turned round.
  return scans.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
}

/** The window the page shows under ETA, or no estimate when its start is empty. */
function windowOf(shipment: JsonObject): WindowEstimate {
  const start = NO_DATE.test(clean(shipment.WindowFrom, 40)) ? null : wallClock(shipment.WindowFrom);
  if (!start) return { expected_delivery: null };
  const end = NO_DATE.test(clean(shipment.WindowTo, 40)) ? null : wallClock(shipment.WindowTo);
  const minute = (local: string) => local.slice(0, 16).replace('T', ' ');
  return windowEstimate(minute(start), end ? minute(end) : undefined);
}

/**
 * The reply of the tracker's GetInformationbyTracking action: a list of shipments, empty for a
 * number the tracker does not hold, each with its current state, its delivery window or time and
 * its history. The delivery address, the signer's name and the signature are not read.
 */
export function parseIslandwide(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIslandwideNumber(raw);
  if (!isRecord(payload)) return invalid('Islandwide returned an invalid reply');
  if (payload.exception !== undefined) throw new IndeterminateError(PROVIDER, 'Islandwide answered with an error');
  if (versionChanged(payload)) return invalid("Islandwide's tracker refused the version of its page the request named");
  const data = isRecord(payload.data) ? payload.data : undefined;
  const list = data && isRecord(data.Out_GetTrackingDetail2) ? data.Out_GetTrackingDetail2.List : undefined;
  if (!Array.isArray(list)) return invalid('Islandwide returned a reply without its shipment list');
  // The page answers an empty list with "The tracking number not exist".
  if (list.length === 0) throw new NotFoundError(PROVIDER);
  if (list.length > 20 || !list.every(isRecord)) return invalid('Islandwide returned a changed shipment list');
  const shipments = list.filter((row) => typeof row.TrackingNumber === 'string' && normalizeTrackingNumber(row.TrackingNumber) === number);
  if (shipments.length === 0) throw new IndeterminateError(PROVIDER, 'Islandwide answered for another number');
  if (shipments.length > 1) throw new IndeterminateError(PROVIDER, 'Islandwide lists several shipments under this number');
  const shipment = shipments[0]!;

  const events = scansOf(shipment);
  const state = typeof shipment.TrackingStateId === 'number' && Number.isSafeInteger(shipment.TrackingStateId)
    && shipment.TrackingStateId > 0 ? String(shipment.TrackingStateId) : '';
  const mapped = state ? islandwideCodeStage(state) : undefined;
  const scanned = events.find((event) => event.stage);
  // The shipment's state is the current one; a state the map does not know leaves the newest staged scan.
  const current = mapped ? { stage: mapped, source: 'carrier_map' }
    : scanned ? { stage: scanned.stage as Stage, source: scanned.stage_source! } : null;
  const newest = events[0];
  if (!newest && !mapped) throw new NoHistoryError(PROVIDER);

  const finished = current?.stage === 'delivered' || current?.stage === 'returned';
  const deliveredAt = current?.stage === 'delivered'
    ? (() => {
      const local = NO_DATE.test(clean(shipment.DeliveryDateTime, 40)) ? null : wallClock(shipment.DeliveryDateTime);
      return local ? dated(local).time : events.find((event) => event.stage === 'delivered')?.time;
    })()
    : undefined;
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest?.description ?? islandwideStatusText(state) ?? null,
    ...(newest ? {} : { provider_code: state, summary_only: true }),
    last_update: newest?.time ?? null,
    ...(newest ? { last_update_local: newest.local_time } : {}),
    ...(finished ? { expected_delivery: null } : windowOf(shipment)),
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events,
  };
}
