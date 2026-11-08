import { isJAndTBrReference } from '../../core/detection/jAndTBr.js';
import { ChallengeError, InvalidInputError, NoHistoryError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { jAndTBrStage } from './status.js';
export const PROVIDER = 'J&T Express Brazil';
export const JT_BR_PAGE = 'https://www.jtexpress.com.br/trajectoryQuery';
export const JT_BR_API = 'https://official.jtjms-br.com/official/logisticsTracking/queryPodTracking';
export const JT_BR_MAX_BYTES = 1_000_000;
export function normalizeJAndTBrNumber(raw: string): string {
  if (!isJAndTBrReference(raw)) throw new InvalidInputError(PROVIDER, 'J&T Brazil needs its fifteen-digit domestic waybill');
  return raw.trim();
}
function clock(raw: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  const m = typeof raw === 'string' && /^(20\d{2})[-/](\d{2})[-/](\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  const day = m && calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!m || !day) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid scan clock');
  const wall = `${day}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (!m[7]) return { local_time: wall };
  const time = wall + m[7];
  if (!explicitOffsetTime(time)) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid stated offset');
  return { time };
}
export function parseJAndTBr(data: unknown, raw: string): CarrierResult {
  const number = normalizeJAndTBrNumber(raw);
  if (isRecord(data) && data.failureKind === 'challenge') throw new ChallengeError(PROVIDER, 'J&T Brazil refused guest verification');
  if (isRecord(data) && data.failureKind === 'rate_limited') throw new RateLimitedError(PROVIDER);
  if (!isRecord(data) || data.code !== 1 || data.succ !== true || data.identityMismatch || !Array.isArray(data.data)
    || data.data.length > 1) throw new SchemaError(PROVIDER, 'J&T Brazil changed its guest tracking reply');
  // An empty success has no response identity or explicit absence claim.
  if (data.data.length === 0) throw new NoHistoryError(PROVIDER, 'J&T Brazil returned no dated history');
  const record: unknown = data.data[0];
  if (!isRecord(record) || record.keyword !== number || !Array.isArray(record.details) || record.details.length > 1000) {
    throw new SchemaError(PROVIDER, 'J&T Brazil returned another waybill or changed its history');
  }
  const events: CarrierEvent[] = record.details.map((value: unknown) => {
    if (!isRecord(value) || typeof value.status !== 'string' || !value.status.trim() || value.status.length > 120
      || /[<>@\r\n]|https?:|\d{9,}/i.test(value.status)) throw new SchemaError(PROVIDER, 'J&T Brazil changed a milestone');
    const code = typeof value.code === 'number' && Number.isSafeInteger(value.code) ? String(value.code)
      : typeof value.code === 'string' && /^[A-Z0-9_-]{1,30}$/.test(value.code) ? value.code : null;
    if (!code) throw new SchemaError(PROVIDER, 'J&T Brazil returned an invalid milestone code');
    const stage = jAndTBrStage(code);
    return { ...clock(value.scanTime), provider_code: code, description: value.status.trim(),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  if (!events.length) throw new NoHistoryError(PROVIDER, 'J&T Brazil returned a waybill without dated history');
  const newest = events[0]!, stage = newest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: newest.provider_code, last_status_text: newest.description,
    last_update: newest.time ?? null, last_update_local: newest.local_time ?? null, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
