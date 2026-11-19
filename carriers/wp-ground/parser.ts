import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { locatePlace, placeTimeZone } from '../../places/index.js';
import { wpGroundStage } from './status.js';

export const PROVIDER = 'WP Ground';

/** WP Ground publishes no number format: one token the tracker would not split. */
export function wpGroundNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (/^[A-Z0-9]{6,40}$/.test(number)) return number;
  throw new InvalidInputError(PROVIDER, 'WP Ground tracking takes one number of 6 to 40 letters and digits');
}

type Row = Record<string, unknown>;
const text = (value: unknown, limit: number) => typeof value === 'string' ? clean(value, limit) : '';

/** The scan's place without a postcode; an address that still holds a number is a street's, and is left out. */
function placeOf(value: unknown): string | undefined {
  const place = text(value, 200).replace(/\b\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/g, ' ')
    .replace(/\s*,\s*(?=,|$)/g, '').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  return place && !/\d/.test(place) ? place : undefined;
}

/** A row's wall clock, with or without seconds; it names no zone. */
function wallClock(value: unknown): string | null {
  const written = text(value, 32);
  for (const format of ['yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd HH:mm']) {
    const clock = DateTime.fromFormat(written, format, { zone: 'UTC' });
    if (clock.isValid) return clock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }
  return null;
}

/**
 * The tracker's answer to `trackQuery` for one number. Its rows carry the number they belong to;
 * an empty list is the tracker's own "No Data". Recipient and sender cities, proof-of-delivery
 * files, sizes and weights are never read.
 */
export function parseWpGround(body: unknown, raw: string): CarrierResult {
  const number = wpGroundNumber(raw);
  if (!body || typeof body !== 'object') throw new SchemaError(PROVIDER, 'WP Ground returned no tracking answer');
  const answer = body as { success?: unknown; data?: { list?: unknown } };
  if (answer.success !== true) throw new IndeterminateError(PROVIDER, 'WP Ground refused the lookup');
  const list = answer.data?.list;
  if (!Array.isArray(list) || list.length > 500) throw new SchemaError(PROVIDER, 'WP Ground returned no scan list');
  if (!list.length) throw new NotFoundError(PROVIDER);
  const rows = list.filter((row): row is Row => Boolean(row) && typeof row === 'object'
    && typeof (row as Row).trackingNumber === 'string' && normalizeTrackingNumber(String((row as Row).trackingNumber).slice(0, 64)) === number);
  if (!rows.length) throw new IndeterminateError(PROVIDER, 'WP Ground answered for another number');
  let events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const local = wallClock(row.trackTime);
    const remarks = text(row.remarks, 320);
    const node = text(row.nodeCode, 120);
    if (!local || !(remarks || node)) throw new SchemaError(PROVIDER, 'WP Ground returned an invalid scan');
    const location = placeOf(row.trackAddress);
    const staged = wpGroundStage(remarks) ?? wpGroundStage(node);
    const event: CarrierEvent = {
      local_time: local, description: remarks || node, ...(node && remarks ? { provider_code: node } : {}),
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Facility instants order the rows when every row can be placed; otherwise their wall clocks do.
  const placed = events.map(event => {
    const place = locatePlace(event.location, { countries: ['US', 'CA'] });
    const zone = place?.precision === 'city' ? placeTimeZone(place) : null;
    const readings = zone ? DateTime.fromISO(event.local_time!, { zone }).getPossibleOffsets() : [];
    return { event, instant: readings.length === 1 ? readings[0]!.toMillis() : undefined };
  });
  events = placed.every(scan => scan.instant !== undefined)
    ? placed.sort((a, b) => b.instant! - a.instant!).map(scan => scan.event)
    : events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const newest = events[0]!;
  const staged = wpGroundStage(newest.description!) ?? wpGroundStage(newest.provider_code ?? '');
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time,
    ...(events.length > 100 ? { history_truncated: true } : {}),
    expected_delivery: null, events: events.slice(0, 100),
  };
}
