import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { latamYouLabel, latamYouStage, statusMap } from './status.js';

export const PROVIDER = 'latam-you';
// An order's rows are about a kilobyte each.
export const LATAM_YOU_MAX_BYTES = 1024 * 1024;

// The line's order numbers: LTY, the destination country, the product and a serial, as LTYBRPD and ten digits.
const NUMBER = /^LTY(?=[A-Z]*\d)[A-Z0-9]{8,37}$/;
// "2023-05-09 20:46:00GMT+08:00": the row's instant, with the offset the service writes it in.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)GMT([+-](?:0\d|1[0-4]):[0-5]\d)$/;
// The destination countries the site names; an order number carries its own after LTY.
const DESTINATIONS = new Set(['BR', 'CL', 'MX', 'CO', 'PE']);
const MAX_ROWS = 300;

/** A Latam You order number, in capitals as the tracker needs it; anything else is not one the guest tracker can bind. */
export function normalizeLatamYouNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Latam You order numbers start with LTY');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? clean(value, maxLength) : invalid(`Latam You returned an invalid ${key}`);
}

interface Scan { index: number; at: number; event: CarrierEvent }

/** One trace row: its instant, the label of its order state and the state's code. */
function scanOf(row: Record<string, unknown>, index: number): Scan {
  const state = row.currentState;
  if (typeof state !== 'number' || !Number.isSafeInteger(state) || state < 0) return invalid('Latam You returned an invalid order state');
  const code = String(state);
  const clock = CLOCK.exec(text(row, 'actTimeShow', 40));
  const parsed = clock ? explicitOffsetTime(`${clock[1]}T${clock[2]}${clock[3]}`) : null;
  if (!parsed) return invalid('Latam You returned an invalid trace time');
  // The page shows the label its state list gives the code, else the code itself.
  const description = text(row, 'currentStateShow', 120) || latamYouLabel(code) || code;
  const stage = latamYouStage(code);
  return { index, at: parsed.timestamp, event: {
    time: parsed.iso, description, provider_code: code, ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  } };
}

/**
 * The reply of `GET /RegisteredPortal/shipmentOrderTrace?inputNo=` for one order: `obj` holds its
 * trace rows, newest first, each naming the order as `sourceNo`. `totalCount` stays 0 even when
 * rows come back, so only `obj` says whether the order exists. The operator who wrote a row, the
 * row's second line (the line's fixed confirmation or the last-mile partner's step code) and the
 * notification fields are left out.
 */
export function parseLatamYou(payload: unknown, raw: string): CarrierResult {
  const number = normalizeLatamYouNumber(raw);
  if (!isRecord(payload) || typeof payload.success !== 'boolean') return invalid('Latam You returned an invalid reply');
  if (!payload.success) throw new IndeterminateError(PROVIDER, 'Latam You did not complete the lookup');
  const rows = payload.obj;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return invalid('Latam You returned an invalid trace list');
  // The tracker's answer for an order it does not hold: an empty list, which the page shows as no order found.
  if (rows.length === 0) throw new NotFoundError(PROVIDER, 'Latam You has no order under this number');
  if (!rows.every(isRecord)) return invalid('Latam You returned an invalid trace row');
  const named = rows.map((row) => normalizeTrackingNumber(text(row, 'sourceNo', 64)));
  if (named.some((sourceNo) => !sourceNo)) return invalid('Latam You returned a trace row without its order');
  if (named.some((sourceNo) => sourceNo !== number)) throw new IndeterminateError(PROVIDER, 'Latam You answered for another order');

  const seen = new Set<string>();
  const scans = rows.map(scanOf).filter(({ event }) => {
    const key = JSON.stringify([event.time, event.provider_code, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  // Newest first; the reply lists the newest first, so of two rows at one instant the first is the newer.
  const events = scans.sort((a, b) => b.at - a.at || a.index - b.index).map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const newest = events[0]!;
  const delivered = stage === 'delivered' ? lead?.time : undefined;
  const country = number.slice(3, 5);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: (lead ?? newest).description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered } : {}),
    ...(DESTINATIONS.has(country) ? { destination_country: country } : {}),
    events,
  };
}
