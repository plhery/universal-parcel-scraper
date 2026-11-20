import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { neighbourStage } from './status.js';

export const PROVIDER = 'Neighbour Express';
export const NEIGHBOUR_ORIGIN = 'https://neighbourexpress.com';
export const NEIGHBOUR_MAX_BYTES = 500000;

export function normalizeNeighbourNumber(raw: string): string {
  const number = raw.length <= 50 ? normalizeTrackingNumber(raw) : '';
  if (!/^(?:NR[A-Z0-9]{4,38}|N[A-Z0-9]{4}R[A-Z0-9]{1,34})$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Neighbour Express guest tracking takes a return-label number');
  }
  return number;
}
export const neighbourPageUrl = (number: string): string => `${NEIGHBOUR_ORIGIN}/track?${new URLSearchParams({ no: number })}`;
export const neighbourLookupUrl = (number: string): string => `${NEIGHBOUR_ORIGIN}/api/basic/zt/api/website/batchTrackByTrackno?${new URLSearchParams({ tracknos: number })}`;

/** This is the native client signal to ask for AJ verification, not a missing parcel. */
export const neighbourNeedsVerification = (data: unknown): boolean => isRecord(data) && (data.code === '1' || data.code === 1) && data.data === 0;

export function parseNeighbour(data: unknown, raw: string): CarrierResult {
  const number = normalizeNeighbourNumber(raw);
  if (neighbourNeedsVerification(data)) throw new ChallengeError(PROVIDER, 'Neighbour Express requires guest verification', { reason: 'guest_verification_required' });
  if (!isRecord(data) || data.code !== '0' && data.code !== 0 || !isRecord(data.data) || !Array.isArray(data.data.results)) {
    throw new SchemaError(PROVIDER, 'Neighbour Express changed its guest tracking reply');
  }
  const results: unknown[] = data.data.results;
  if (results.length === 0) throw new IndeterminateError(PROVIDER, 'Neighbour Express returned no bound history');
  if (results.length !== 1 || !isRecord(results[0]) || results[0].trackno !== number) {
    throw new SchemaError(PROVIDER, 'Neighbour Express did not identify one whole return label');
  }
  const result = results[0];
  if (result.status !== 'success') throw new IndeterminateError(PROVIDER, 'Neighbour Express did not confirm a return history');
  if (!Array.isArray(result.data)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its event list');
  if (!result.data.length) throw new IndeterminateError(PROVIDER, 'Neighbour Express returned no dated scans');
  if (result.data.length > 300) throw new SchemaError(PROVIDER, 'Neighbour Express returned too many events');
  const events: CarrierEvent[] = result.data.map((row: unknown) => {
    if (!isRecord(row) || typeof row.statusText !== 'string' || !row.statusText.trim() || row.statusText.length > 300
      || !['string', 'number'].includes(typeof row.status) || !/^\d{1,8}$/.test(String(row.status))
      || typeof row.time !== 'string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.time)
      || typeof row.timezone !== 'string' || !/^UTC[+-](?:0\d|1[0-4]):[0-5]\d$/.test(row.timezone)
      || /^UTC[+-]14:(?!00)/.test(row.timezone)) throw new SchemaError(PROVIDER, 'Neighbour Express changed its scan fields');
    const local = row.time.replace(' ', 'T'), clock = explicitOffsetTime(local + row.timezone.slice(3));
    if (!clock) throw new SchemaError(PROVIDER, 'Neighbour Express returned an invalid scan clock');
    const description = clean(row.statusText, 300), code = String(row.status), stage = neighbourStage(code, description);
    return { time: clock.iso, local_time: local, time_zone: row.timezone, time_zone_basis: 'carrier',
      description, provider_code: code, ...(stage ? { stage, stage_source: 'explicit_mapping' } : {}) };
  }).reverse().sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const latest = events[0]!, stage = neighbourStage(latest.provider_code!, latest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage ?? 'unknown',
    current_stage_source: stage ? 'explicit_mapping' : 'none', last_status_text: latest.description!,
    last_update: latest.time!, last_update_local: latest.local_time!, timezone: latest.time_zone!, expected_delivery: null,
    canonical_tracking_number: number, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}),
    ...(stage === 'delivered' ? { delivered_at: latest.time! } : {}) };
}
