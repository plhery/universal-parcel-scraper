import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean, cleanScalar, textFromHtml } from '../../core/transport/text.js';
import { xendnowStage } from './status.js';

export const PROVIDER = 'xendnow';
// A history of a dozen rows is about 4 kB.
export const XENDNOW_MAX_BYTES = 512 * 1024;

// Box ids such as the one on the tracking page's example card: letters and digits.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{6,30}$/;
// "2020-03-12 12:58:12": a wall clock with no zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const CODE = /^\d{1,3}$/;
const HANDOFF = /^[A-Z0-9]{4,40}$/;
// The catalog's DHL networks. Of these, only DHL Express delivers in Malaysia.
const DHL = new Set(['dhl', 'dhl-express', 'dhl-ecommerce', 'dhl-ecommerce-es', 'dhl-ecommerce-nl', 'dhl-ecommerce-pl',
  'dhl-ecommerce-uk', 'dhl-freight']);
const DHL_IN_MALAYSIA = 'dhl-express';
const MAX_ROWS = 500;

type Row = Record<string, unknown>;

/** A box id for XendNow's tracker. */
export function normalizeXendnowNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the tracking number on the XendNow label');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** One of the API's lists, each row about the box asked. */
function rowsFor(payload: unknown, number: string, what: string): Row[] {
  if (!Array.isArray(payload) || payload.length > MAX_ROWS) return invalid(`XendNow returned an invalid ${what}`);
  return payload.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return invalid(`XendNow returned an invalid ${what}`);
    const box = normalizeTrackingNumber(clean((row as Row).boxid, 64));
    if (!box) return invalid(`XendNow returned a ${what} without its box`);
    if (box !== number) throw new IndeterminateError(PROVIDER, 'XendNow answered for another box');
    return row as Row;
  });
}

function wallClock(value: unknown): string {
  const parts = CLOCK.exec(clean(value, 40));
  const date = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !date || Number(parts[1]) < 2000) return invalid('XendNow returned an invalid scan time');
  return `${date}T${parts[4]}:${parts[5]}:${parts[6]}`;
}

/**
 * A history row. Its wording can be followed by a collection point's opening hours on
 * further lines, which are left out. The receiver's name and IC number, the signature, the
 * drop-off proof and the courier's free-text remark are never read.
 */
function eventOf(row: Row): CarrierEvent & { local_time: string; provider_code: string } {
  const code = cleanScalar(row.status, 8);
  if (!CODE.test(code)) return invalid('XendNow returned an invalid status code');
  const wording = typeof row.DelStatus === 'string' ? textFromHtml(row.DelStatus.split(/<br\s*\/?>/i)[0], 200) : '';
  if (!wording) return invalid('XendNow returned a row without its status');
  const staged = xendnowStage(code, wording);
  return {
    local_time: wallClock(row.pdate), description: wording, provider_code: code,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/** The DHL number the box was handed over under, when the box's detail names one. */
function dhlHandoff(rows: readonly Row[], number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const ids = new Set(rows.filter((row) => cleanScalar(row.is_dhl, 4) === '1')
    .map((row) => normalizeTrackingNumber(clean(row.trackingid_for_dhl, 64))).filter(Boolean));
  const [id] = ids;
  if (ids.size !== 1 || !id || !HANDOFF.test(id) || id === number) return {};
  // A shape one DHL network issues names it; a shared one names DHL Express when its rules offer the number.
  const match = detectCarrierMatch(id);
  const network = match.confidence === 'high' ? (DHL.has(match.carrier) ? match.carrier : undefined)
    : (match.candidates as readonly string[]).includes(DHL_IN_MALAYSIA) ? DHL_IN_MALAYSIA : undefined;
  return { delivery_tracking_number: id, ...(network ? { delivery_carrier: network } : {}) };
}

/**
 * The replies of XendNow's tracking API for one box: `track_parcel_history`, its scans
 * newest first, and `track_parcel_detail`, the box's card, which names the DHL number when
 * DHL delivers the box. Both answer `[]` for a box they do not know. The card's address and
 * phone number are never read.
 */
export function parseXendnow(history: unknown, detail: unknown, raw: string): CarrierResult {
  const number = normalizeXendnowNumber(raw);
  const rows = rowsFor(history, number, 'history');
  const cards = rowsFor(detail, number, 'box detail');
  const handoff = dhlHandoff(cards, number);
  if (!rows.length && !cards.length) throw new NotFoundError(PROVIDER, 'XendNow has no record of this box');
  if (!rows.length) {
    throw new NoHistoryError(PROVIDER, 'XendNow has the box but no scan yet', {
      ...(handoff.delivery_carrier ? { deliveryCarrier: handoff.delivery_carrier } : {}),
      ...(handoff.delivery_tracking_number ? { deliveryTrackingNumber: handoff.delivery_tracking_number } : {}),
    });
  }

  // Newest first; rows of one second keep the API's order.
  const events = rows.map(eventOf).sort((a, b) => b.local_time.localeCompare(a.local_time));
  const newest = events[0]!;
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged!.stage_source! } : {}),
    provider_code: newest.provider_code,
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...handoff,
    events,
  };
}
