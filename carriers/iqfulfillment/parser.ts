import { carrierTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochSecondsTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { IQFULFILLMENT_MAX_LENGTH, IQFULFILLMENT_MIN_LENGTH, IQFULFILLMENT_REFERENCE } from './number.js';
import { iqfulfillmentStage, statusMap } from './status.js';

export const PROVIDER = 'iqfulfillment';
// A delivered order's reply is under 1 kB.
export const IQFULFILLMENT_MAX_BYTES = 64 * 1024;
// The service's own answer for a reference it holds no order under, sent with HTTP 404.
const NOT_FOUND = 'You have entered an invalid tracking number.';
const MAX_ROWS = 50;
// 2015-01-01T00:00:00Z: no milestone is older than the tracker.
const EARLIEST = 1_420_070_400;

/** An order reference as the tracker takes it: five to forty letters and digits, with a digit, and any hyphen it carries. */
export function normalizeIqFulfillmentNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? carrierTrackingNumber(raw, PROVIDER) : '';
  if (number.length < IQFULFILLMENT_MIN_LENGTH || number.length > IQFULFILLMENT_MAX_LENGTH || !IQFULFILLMENT_REFERENCE.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Enter the order tracking number from the seller\'s or IQ Fulfillment\'s email');
  }
  return number;
}

/** The service's answer that it holds no order under the reference asked. */
export function isIqFulfillmentNotFound(payload: unknown): boolean {
  return isRecord(payload) && payload.success === false && payload.code === 404 && payload.message === NOT_FOUND;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** A text field: absent, null or a string of at most `max` characters; anything else is a changed reply. */
function text(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[<>]/.test(value)) return invalid(`IQ Fulfillment returned an invalid ${key}`);
  return clean(value, max);
}

/**
 * `POST /v1/tracking/history`'s reply for one reference: `success`, the reference asked,
 * `current_status` and the milestones oldest first, each a title, a fixed sentence under it, a
 * Unix time and a colour. The reply must name the whole reference asked. The sentences and the
 * colours add nothing to the titles and are left out; the times are instants.
 */
export function parseIqFulfillment(payload: unknown, raw: string): CarrierResult {
  const number = normalizeIqFulfillmentNumber(raw);
  if (isIqFulfillmentNotFound(payload)) throw new NotFoundError(PROVIDER, 'IQ Fulfillment has no order under this reference');
  if (!isRecord(payload) || payload.success !== true) return invalid('IQ Fulfillment returned an unexpected reply');
  const echoed = text(payload, 'tracking_number', 64);
  if (!echoed) return invalid('IQ Fulfillment returned a reply without its reference');
  // The page uppercases the reference and the service finds it whatever its case.
  if (echoed.toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'IQ Fulfillment answered for another order');
  const current = text(payload, 'current_status', 80);
  const history = payload.history ?? [];
  if (!Array.isArray(history) || history.length > MAX_ROWS) return invalid('IQ Fulfillment returned an invalid history');

  const seen = new Set<string>();
  const rows: { at: number; index: number; event: CarrierEvent }[] = [];
  for (const [index, row] of (history as unknown[]).entries()) {
    if (!isRecord(row)) return invalid('IQ Fulfillment returned an invalid milestone');
    const title = text(row, 'title', 80);
    if (!title) return invalid('IQ Fulfillment returned a milestone without its title');
    const time = Number.isInteger(row.time) && (row.time as number) >= EARLIEST ? epochSecondsTime(row.time) : null;
    if (!time) return invalid('IQ Fulfillment returned an invalid milestone time');
    const key = JSON.stringify([time.timestamp, title]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = iqfulfillmentStage(title);
    rows.push({ at: time.timestamp, index, event: { time: time.iso, description: title,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) } });
  }
  // Newest first; milestones written in the same second keep the reply's order, the later one newer.
  const events = rows.sort((a, b) => b.at - a.at || b.index - a.index).map(({ event }) => event);
  if (!events.length && !current) return invalid('IQ Fulfillment returned an order without a status or milestones');

  // The status the page shows in large letters, else the milestone that leads.
  const shown = current ? iqfulfillmentStage(current) : null;
  const lead = leadingScan(events, statusMap);
  const stage = (shown?.stage ?? lead?.stage) as Stage | undefined;
  const source = shown?.source ?? lead?.stage_source ?? 'carrier_map';
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: current || events[0]!.description!,
    last_update: events[0]?.time ?? null,
    expected_delivery: null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}
