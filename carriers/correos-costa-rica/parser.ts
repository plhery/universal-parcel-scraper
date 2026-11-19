import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { costaRicaStage, statusMap } from './status.js';

export const PROVIDER = 'Correos de Costa Rica';
export const MAX_BYTES = 600_000;
export function normalizeCostaRicaNumber(raw: string): string {
  const number = raw.length <= 80 && /^[A-Za-z0-9\s-]+$/.test(raw) ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8,30}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}
function localClock(raw: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}) (AM|PM)$/.exec(raw);
  if (!match || +match[4]! < 1 || +match[4]! > 12) throw new SchemaError(PROVIDER, 'Correos returned an invalid scan clock');
  const clock = DateTime.fromObject({ year: 2000 + +match[3]!, month: +match[2]!, day: +match[1]!,
    hour: +match[4]! % 12 + (match[6] === 'PM' ? 12 : 0), minute: +match[5]! }, { zone: 'UTC' });
  if (!clock.isValid) throw new SchemaError(PROVIDER, 'Correos returned an invalid scan clock');
  return clock.toFormat("yyyy-MM-dd'T'HH:mm");
}
export function parseCostaRica(data: unknown, raw: string): CarrierResult {
  const number = normalizeCostaRicaNumber(raw);
  if (!isRecord(data)) throw new SchemaError(PROVIDER, 'Correos returned invalid tracking data');
  if (data.kind === 'not_found') throw new NotFoundError(PROVIDER);
  if (data.kind === 'challenge') throw new ChallengeError(PROVIDER);
  if (data.kind === 'identity_mismatch') throw new IndeterminateError(PROVIDER, 'Correos answered for another shipment');
  if (data.kind === 'unconfirmed') throw new IndeterminateError(PROVIDER, 'Correos did not return a shipment result');
  if (data.kind !== 'history' || data.number !== number || !Array.isArray(data.events) || data.events.length > 500) throw new SchemaError(PROVIDER);
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of data.events) {
    if (!isRecord(row) || typeof row.clock !== 'string' || typeof row.location !== 'string' || row.location.length > 200
      || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1000) throw new SchemaError(PROVIDER);
    const description = row.description.trim(), location = row.location.trim(), stage = costaRicaStage(description);
    const event: CarrierEvent = { local_time: localClock(row.clock), description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event); if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!, staged = leadingScan(events, statusMap), stage = staged?.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged?.stage ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events };
}
