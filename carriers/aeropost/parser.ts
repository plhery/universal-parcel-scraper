import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { isAeropostReference } from '../../core/detection/aeropost.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { aeropostStage } from './status.js';

export const PROVIDER = 'Aeropost';
export const AEROPOST_API = 'https://aeropost.com/api/tracking';
export const AEROPOST_MAX_BYTES = 1_000_000;

export function normalizeAeropostNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isAeropostReference(number)) throw new InvalidInputError(PROVIDER, 'Aeropost native tracking requires its Costa Rican shipper number');
  return number;
}

function invalid(): never { throw new SchemaError(PROVIDER, 'Aeropost returned invalid shipment history'); }

/** Called only after the browser binds the page's exact whole-number shipper POST. */
export function parseAeropost(payload: unknown): CarrierResult {
  if (!isRecord(payload) || !Array.isArray(payload.events) || payload.events.length > 500) invalid();
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of payload.events) {
    if (!isRecord(row) || !(typeof row.code === 'string' && /^\d{1,5}$/.test(row.code)
      || typeof row.code === 'number' && Number.isSafeInteger(row.code) && row.code >= 0 && row.code < 100000)
      || typeof row.status !== 'string' || !row.status.trim() || row.status.length > 500
      || typeof row.date_time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.date_time)
      || typeof row.country_code !== 'string' || !/^[A-Z]{2}$/.test(row.country_code)) invalid();
    const local = DateTime.fromFormat(row.date_time, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
    if (!local.isValid || local.toFormat('yyyy-MM-dd HH:mm:ss') !== row.date_time) invalid();
    const code = String(row.code);
    // The official status table names this as a processing placeholder, not a scan.
    if (code === '1500') continue;
    const stage = aeropostStage(code);
    const event: CarrierEvent = { local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"), provider_time_text: row.date_time,
      provider_code: code, description: row.status.trim(), location: row.country_code,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const identity = JSON.stringify(event);
    if (!seen.has(identity)) { seen.add(identity); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The carrier supplies newest-first local clocks; it states no offsets.
  const current = events[0]!, stage = current.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description, last_update: null, last_update_local: current.local_time,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}
