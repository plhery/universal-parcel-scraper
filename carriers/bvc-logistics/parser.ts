import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { bvcStage, statusMap } from './status.js';

export const PROVIDER = 'BVC Logistics';
export const CARRIER = 'bvc-logistics';
/** India's clock, on which the tracking page shows each scan to a visitor in India. */
export const BVC_ZONE = 'Asia/Kolkata';

// The page refuses a number shorter than seven characters; its field takes 80, for several numbers.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{7,30}$/;
// An instant in UTC, as OutSystems sends a date and time to the browser.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
// OutSystems' empty date and time, without a zone.
const NO_TIME = /^1900-01-01T00:00:00$/;
const MAX_ROWS = 300;

/** A shipping note number for BVC's tracker. */
export function normalizeBvcNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'BVC Logistics shipping note numbers are 7 to 30 letters and digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** Whether the tracker says the request named an older build of its page, or of the action. */
export function versionChanged(payload: unknown): boolean {
  const info = isRecord(payload) ? payload.versionInfo : undefined;
  return isRecord(info) && (info.hasModuleVersionChanged === true || info.hasApiVersionChanged === true);
}

interface Scan { event: CarrierEvent; timestamp: number; index: number }

/**
 * One row of the history, or null for a row without a time. `Time` is a UTC instant: the page
 * shows it on the visitor's clock, and read on India's clock the sample's scans fall in a working
 * day. `Location` is the step's wording; the place is the row's town, else its hub's name.
 */
function scanOf(row: unknown, number: string, index: number): Scan | null {
  if (!isRecord(row) || typeof row.ShipmentNoteNumber !== 'string' || typeof row.Time !== 'string') {
    return invalid('BVC Logistics returned a changed history row');
  }
  if (normalizeTrackingNumber(row.ShipmentNoteNumber) !== number) {
    throw new IndeterminateError(PROVIDER, 'BVC Logistics answered for another number');
  }
  const raw = clean(row.Time, 40);
  if (NO_TIME.test(raw)) return null;
  const instant = INSTANT.test(raw) ? DateTime.fromISO(raw, { setZone: true }) : null;
  if (!instant?.isValid || instant.year < 2000) return invalid('BVC Logistics returned an invalid scan time');
  const description = clean(row.Location, 200) || invalid('BVC Logistics returned a scan without its step');
  const location = clean(row.City, 120) || (isRecord(row.Hub) ? clean(row.Hub.Name, 120) : '');
  const staged = bvcStage(description);
  return {
    event: {
      time: instant.setZone(BVC_ZONE).toISO({ suppressMilliseconds: true })!,
      ...(location ? { location } : {}),
      description,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    },
    timestamp: instant.toMillis(),
    index,
  };
}

/**
 * The reply of the tracker's GetTrackData action for one shipping note number: the numbers it was
 * asked about, and the scans it holds for them, newest first. A number it does not hold gets no scan.
 */
export function parseBvc(payload: unknown, raw: string): CarrierResult {
  const number = normalizeBvcNumber(raw);
  if (!isRecord(payload)) return invalid('BVC Logistics returned an invalid reply');
  if (payload.exception !== undefined) throw new IndeterminateError(PROVIDER, 'BVC Logistics answered with an error');
  if (versionChanged(payload)) return invalid("BVC Logistics' tracker refused the version of its page the request named");
  const data = isRecord(payload.data) ? payload.data : undefined;
  const asked = data && isRecord(data.ShippingNoteNumbers) ? data.ShippingNoteNumbers.List : undefined;
  const rows = data && isRecord(data.Trackings) ? data.Trackings.List : undefined;
  if (!Array.isArray(asked) || !Array.isArray(rows)) return invalid('BVC Logistics returned a reply without its lists');
  // The tracker names the numbers it read from the request; an answer about others says nothing of this one.
  if (asked.length !== 1 || typeof asked[0] !== 'string' || normalizeTrackingNumber(asked[0]) !== number) {
    throw new IndeterminateError(PROVIDER, 'BVC Logistics answered for another number');
  }
  // The page shows nothing under the number when the list is empty.
  if (rows.length === 0) throw new NotFoundError(PROVIDER, 'BVC Logistics has no record of this shipping note');
  if (rows.length > MAX_ROWS) return invalid('BVC Logistics returned an oversized history');

  const seen = new Set<string>();
  const events = rows.map((row, index) => scanOf(row, number, index))
    .filter((scan): scan is Scan => {
      if (!scan) return false;
      const key = JSON.stringify([scan.timestamp, scan.event.description, scan.event.location ?? '']);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Newest first, as the reply mostly lists them; scans of one instant keep its order.
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
    .map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);

  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const deliveredAt = stage === 'delivered' ? lead?.time : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: String(lead?.stage_source) } : {}),
    last_status_text: String(newest.description),
    last_update: newest.time ?? null,
    expected_delivery: null,
    ...(deliveredAt ? { delivered_at: deliveredAt } : {}),
    events,
  };
}
