import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { unreadEstimates } from '../../core/result/unread.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { iberomailStage, statusMap } from './status.js';

export const PROVIDER = 'iberomail';
// A shipment with its rows is a few kilobytes.
export const IBEROMAIL_MAX_BYTES = 512 * 1024;

// The tracker takes any keyword; Iberomail's own numbers are W and six digits, its partners' S10 numbers longer.
const NUMBER = /^(?=[A-Z]*\d)[A-Z0-9]{5,40}$/;
// "2026-10-23T12:37:31": a row's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// A delivery row names its signatory after the wording: "ENTREGADO con Firma:  DNI: … NOMBRE: …".
const SIGNATORY = /[\s:]*\b(?:DNI|NIF|NIE|NOMBRE|NOME)\s*:.*$/is;
const PARTNER_NUMBER = /^[A-Z0-9]{4,40}$/;
const MAX_TRACKINGS = 20;
const MAX_ROWS = 300;

/** A number for Iberomail's tracker: letters and digits, in capitals. */
export function normalizeIberomailNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Enter the Iberomail waybill number (carta de porte)');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field: null or a string, anything else a changed reply. */
function text(record: Record<string, unknown>, key: string, maxLength = 300): string {
  const value = record[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`Iberomail returned an invalid ${key}`);
}

function wallClock(value: string): string {
  const parts = CLOCK.exec(value);
  const day = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  if (!parts || !day || Number(parts[1]) < 2001) return invalid('Iberomail returned an unreadable row time');
  return `${day}T${parts[4]}:${parts[5]}:${parts[6] ?? '00'}`;
}

interface Row { index: number; event: CarrierEvent }
interface Shipment { dated: Row[]; undated: string[]; partner: string; estimates: Record<string, unknown> }

function rowOf(value: unknown, index: number): { row?: Row; undated?: string } {
  if (!isRecord(value)) return invalid('Iberomail returned an invalid row');
  // The signatory's id and name stay behind.
  const description = clean(text(value, 'message', 500).replace(SIGNATORY, ''), 300);
  const clock = text(value, 'checkpoint_time', 40);
  if (!description) return {};
  if (!clock) return { undated: description };
  const location = text(value, 'location', 120);
  const staged = iberomailStage(description);
  return { row: { index, event: {
    local_time: wallClock(clock), description, ...(location ? { location } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  } } };
}

/** One tracking of the reply: its dated rows, the wording of rows without a clock, and a partner's number. */
function shipmentOf(tracking: Record<string, unknown>, number: string): Shipment {
  const checkpoints = tracking.checkpoints ?? [];
  if (!Array.isArray(checkpoints) || checkpoints.length > MAX_ROWS) return invalid('Iberomail returned invalid rows');
  const dated: Row[] = [];
  const undated: string[] = [];
  const seen = new Set<string>();
  for (const [index, checkpoint] of checkpoints.entries()) {
    const { row, undated: wording } = rowOf(checkpoint, index);
    if (wording) undated.push(wording);
    if (!row) continue;
    const key = JSON.stringify([row.event.local_time, row.event.description, row.event.location ?? '']);
    if (seen.has(key)) continue;
    seen.add(key);
    dated.push(row);
  }
  // `tracking_number` holds the partner's number when another network carries the parcel, an S10 one abroad.
  const own = normalizeTrackingNumber(text(tracking, 'order_id', 64));
  const listed = normalizeTrackingNumber(text(tracking, 'tracking_number', 64));
  const partner = PARTNER_NUMBER.test(listed) && listed !== number && listed !== own ? listed : '';
  return { dated, undated, partner, estimates: {
    // AfterShip's estimate fields, empty in every reply seen.
    expected_delivery: tracking.expected_delivery, order_promised_delivery_date: tracking.order_promised_delivery_date,
  } };
}

const same = (value: unknown, number: string) => typeof value === 'string' && normalizeTrackingNumber(value) === number;

/**
 * The reply of `search.php` for one number: a list of AfterShip-shaped trackings, which the
 * service finds by keyword. Only a tracking whose own number or partner number is the one asked
 * counts. Rows without a clock are Iberomail's summary, never dated history; the others keep
 * their wall clock, as the reply gives no zone and a parcel abroad is scanned in other ones.
 */
export function parseIberomail(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIberomailNumber(raw);
  if (isRecord(payload) && isRecord(payload.meta)) throw new IndeterminateError(PROVIDER, 'Iberomail did not complete the lookup');
  if (!Array.isArray(payload) || payload.length > MAX_TRACKINGS) return invalid('Iberomail returned an unreadable reply');
  // The tracker shows "Unknown" for an empty list.
  if (payload.length === 0) throw new NotFoundError(PROVIDER, 'Iberomail has no shipment under this number');
  const own = payload.filter((tracking) => (isRecord(tracking)
    ? same(tracking.order_id, number) || same(tracking.tracking_number, number) : invalid('Iberomail returned an invalid tracking')));
  if (own.length === 0) throw new IndeterminateError(PROVIDER, 'Iberomail answered for another shipment');
  const shipments = own.map((tracking) => shipmentOf(tracking as Record<string, unknown>, number));
  // The same record listed twice is one shipment; two that differ name none of them.
  if (new Set(shipments.map((shipment) => JSON.stringify(shipment))).size > 1) {
    throw new IndeterminateError(PROVIDER, 'Iberomail lists several shipments under this number');
  }
  const { dated, undated, partner, estimates } = shipments[0]!;
  const facts = { ...(partner ? { delivery_tracking_number: partner } : {}), ...unreadEstimates(estimates) };

  if (!dated.length) {
    // The reply lists the oldest row first: the last one without a clock is where the summary stands.
    const latest = undated.at(-1);
    if (!latest) {
      throw new NoHistoryError(PROVIDER, 'Iberomail lists the shipment without rows', { reason: 'listed',
        ...(partner ? { deliveryTrackingNumber: partner } : {}) });
    }
    const staged = iberomailStage(latest);
    return {
      status: staged ? languageStageStatus(staged.stage) : 'unknown',
      ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
      last_status_text: latest, last_update: null, expected_delivery: null, ...facts, summary_only: true, events: [],
    };
  }

  // Newest first; of two rows at one clock, the reply's later one is the newer.
  const events = dated.sort((a, b) => b.event.local_time!.localeCompare(a.event.local_time!) || b.index - a.index)
    .map((row) => row.event);
  // The proof of delivery noted after the delivery moves nothing, so the delivery stands under it.
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: events[0]!.description!,
    last_update: null,
    last_update_local: events[0]!.local_time!,
    expected_delivery: null,
    ...facts,
    events,
  };
}
