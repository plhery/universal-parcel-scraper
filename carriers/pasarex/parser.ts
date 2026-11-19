import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { pasarexStage } from './status.js';

export const PROVIDER = 'PasarEX';
export const MAX_BYTES = 600_000;
const MAX_EVENTS = 100;

/** PasarEX's tracker takes Amazon's numbers and its own guides: one token of letters and digits. */
export function normalizePasarexNumber(raw: string): string {
  const number = raw.length <= 80 && /^[A-Za-z0-9\s-]+$/.test(raw) ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{6,30}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER, 'PasarEX tracking takes one number of 6 to 30 letters and digits');
  return number;
}

/** A row's day and second, a wall clock without an offset. */
function localClock(date: string, hour: string): string {
  const clock = DateTime.fromFormat(`${date} ${hour}`, 'dd/MM/yyyy HH:mm:ss', { zone: 'UTC' });
  if (!clock.isValid) throw new SchemaError(PROVIDER, 'PasarEX returned an invalid scan clock');
  return clock.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) throw new SchemaError(PROVIDER, 'PasarEX returned an invalid scan');
  return value.trim();
};

/**
 * The browser helper's reading of the result page: the order's number and its rows, grouped under the tracker's
 * statuses rather than in time order, each with a sentence, a city or none, a day and a second.
 */
export function parsePasarex(data: unknown, raw: string): CarrierResult {
  const number = normalizePasarexNumber(raw);
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'PasarEX returned invalid tracking data');
  if (data.kind === 'not_found') throw new NotFoundError(PROVIDER);
  if (data.kind === 'challenge') throw new ChallengeError(PROVIDER);
  if (data.kind === 'identity_mismatch') throw new IndeterminateError(PROVIDER, 'PasarEX answered for another shipment');
  if (data.kind === 'unconfirmed') throw new IndeterminateError(PROVIDER, 'PasarEX did not return a shipment result');
  if (data.kind !== 'history' || data.number !== number || !Array.isArray(data.groups) || data.groups.length > 50) throw new SchemaError(PROVIDER);
  const events: (CarrierEvent & { local_time: string })[] = [], seen = new Set<string>();
  for (const group of data.groups) {
    if (!isRecord(group) || !Array.isArray(group.rows) || group.rows.length > 500) throw new SchemaError(PROVIDER, 'PasarEX tracking columns changed');
    text(group.status, 100);
    for (const row of group.rows) {
      if (!isRecord(row)) throw new SchemaError(PROVIDER, 'PasarEX returned an invalid scan');
      const description = text(row.description, 1000), location = text(row.city, 200);
      if (!description) throw new SchemaError(PROVIDER, 'PasarEX returned a scan without wording');
      const local_time = localClock(text(row.date, 20), text(row.hour, 20));
      const key = JSON.stringify([local_time, description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const staged = pasarexStage(description);
      events.push({ local_time, description, ...(location ? { location } : {}),
        ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
    }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // Newest first; rows of one second keep the page's order.
  events.sort((a, b) => (a.local_time < b.local_time ? 1 : a.local_time > b.local_time ? -1 : 0));
  const newest = events[0]!;
  const staged = pasarexStage(newest.description!);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
    events: events.slice(0, MAX_EVENTS),
  };
}
