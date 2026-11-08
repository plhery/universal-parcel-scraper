import { DateTime } from 'luxon';
import { detectCarrierMatch, normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { kuayuanStage } from './status.js';

export const PROVIDER = 'Kuayuan Express';
// A long history is a few kilobytes of JSON.
export const KUAYUAN_MAX_BYTES = 256 * 1024;

// A digit, three letters and ten digits: the numbers Kuayuan's tracker answers with its scans.
const NUMBER = /^\d[A-Z]{3}\d{10}$/;
// "2026-11-02 22:14:19": a wall clock without a zone.
const CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CODE = /^[A-Z]{1,12}$/;
// The answer for a number the tracker has nothing for, in English and in Chinese.
const NO_TRACKS = /^(?:Trajectory Information does not exist|轨迹信息不存在)$/i;
const BUSY = /频繁|too many|rate limit/i;
const MAX_SHIPMENTS = 20;
const MAX_ROWS = 300;

/** A Kuayuan number in upper case, as the tracker reads it; anything else is not one Kuayuan issues. */
export function normalizeKuayuanNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Kuayuan Express numbers are a digit, three letters and ten digits');
  return number;
}

/** An optional text field; anything but a string is a changed reply. */
function text(row: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = row[key];
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new SchemaError(PROVIDER, `Kuayuan Express returned an invalid ${key}`);
  return clean(value, maxLength);
}

/** A scan's date and second as one wall time. The reply gives no zone. */
function wallClock(raw: string): string {
  const match = CLOCK.exec(raw);
  const local = match ? `${match[1]}T${match[2]}` : '';
  // Parsing in UTC checks the calendar digits only; the wall clock keeps no offset.
  if (!match || DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) {
    throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid scan time');
  }
  return local;
}

/**
 * The number Kuayuan gave the parcel's line and that line's carrier, when it is
 * not the number asked and one carrier's high-confidence rule claims it: the
 * reply names no carrier.
 */
function handoff(shipment: Record<string, unknown>, number: string): Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> {
  const line = normalizeTrackingNumber(text(shipment, 'server_hawbcode', 64));
  if (!/^[A-Z0-9]{4,40}$/.test(line) || line === number) return {};
  const detected = detectCarrierMatch(line);
  return detected.confidence === 'high' && (detected.carrier as string) !== 'kuayuan-express'
    ? { delivery_carrier: detected.carrier, delivery_tracking_number: line } : {};
}

/**
 * The reply of the home page's `getTrackInfoOutside` call: `detail['']` lists
 * one entry per number asked. A number the tracker knows is `ask: 1` with the
 * shipment: Kuayuan's number (`shipper_hawbcode`), the line's (`server_hawbcode`),
 * the destination's code and the scans, newest first, each a wall clock, a
 * place, a wording and a code. One it has nothing for is `ask: 0`. The shipment
 * must be the number asked. The recipient's name and town and the customer's
 * reference are not kept.
 */
export function parseKuayuan(payload: unknown, raw: string): CarrierResult {
  const number = normalizeKuayuanNumber(raw);
  if (!isRecord(payload) || typeof payload.code !== 'number') throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid envelope');
  if (payload.code !== 200) {
    if (BUSY.test(clean(payload.message, 200))) throw new RateLimitedError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Kuayuan Express did not complete the lookup');
  }
  const detail = isRecord(payload.data) ? payload.data.detail : undefined;
  const entries = isRecord(detail) ? detail[''] : undefined;
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_SHIPMENTS || !entries.every(isRecord)) {
    throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid result list');
  }
  const entry = (entries as Record<string, unknown>[]).find((candidate) => normalizeTrackingNumber(text(candidate, 'code', 64)) === number);
  if (!entry) throw new IndeterminateError(PROVIDER, 'Kuayuan Express answered for another shipment');
  if (entry.ask === 0) {
    if (NO_TRACKS.test(text(entry, 'message'))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Kuayuan Express did not complete the lookup');
  }
  const shipment = entry.data;
  if (entry.ask !== 1 || !isRecord(shipment)) throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid shipment');
  if (![text(shipment, 'shipper_hawbcode', 64), text(shipment, 'server_hawbcode', 64)]
    .some((value) => normalizeTrackingNumber(value) === number)) {
    throw new IndeterminateError(PROVIDER, 'Kuayuan Express answered for another shipment');
  }
  const rows = shipment.track_detail_list ?? [];
  if (!Array.isArray(rows)) throw new SchemaError(PROVIDER, 'Kuayuan Express returned invalid scans');
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Kuayuan Express returned too many scans');

  const scans: { local: string; event: CarrierEvent }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid scan');
    const local = wallClock(text(row, 'track_date', 32));
    const description = text(row, 'track_content');
    if (!description) throw new SchemaError(PROVIDER, 'Kuayuan Express returned a scan without wording');
    const code = text(row, 'track_code', 32);
    if (code && !CODE.test(code)) throw new SchemaError(PROVIDER, 'Kuayuan Express returned an invalid scan code');
    const location = text(row, 'track_location', 120);
    const identity = JSON.stringify([local, code, description, location]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const staged = kuayuanStage(code || null, description);
    scans.push({ local, event: {
      local_time: local,
      ...(location ? { location } : {}),
      description,
      ...(code ? { provider_code: code } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    } });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER);
  // Newest first; equal clocks keep the reply's order.
  scans.sort((left, right) => right.local.localeCompare(left.local));
  const events = scans.map(({ event }) => event);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const country = countryCode(text(shipment, 'country_code', 8));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: null,
    last_update_local: scans[0]!.local,
    ...(country ? { destination_country: country } : {}),
    ...handoff(shipment, number),
    events,
  };
}
