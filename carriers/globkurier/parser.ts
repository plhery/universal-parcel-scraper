import { DateTime } from 'luxon';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, trackingLanguageStage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { stageForCode } from './status.js';

export const provider = 'globkurier';
export const referencePattern = /^GK\d{10,16}$/;

function parseEvent(value: unknown): CarrierEvent {
  if (!isRecord(value)) throw new SchemaError(provider, 'Invalid GlobKurier movement record');
  const code = clean(value.type, 90);
  const name = clean(value.name, 160);
  const wording = name || code;
  if (!wording) throw new SchemaError(provider, 'GlobKurier movement lacks a status');
  const rawClock = clean(value.date, 80);
  const date = DateTime.fromFormat(rawClock, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  const location = clean(value.location, 120);
  const mapped = stageForCode(code);
  const stage = mapped ?? trackingLanguageStage(wording);
  return {
    description: wording,
    ...(code ? { provider_code: code } : {}),
    ...(date.isValid ? { local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss") } : rawClock ? { provider_time_text: rawClock } : {}),
    ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
  };
}

export function parseTracking(body: unknown, httpStatus: number): CarrierResult {
  if (!isRecord(body)) throw new SchemaError(provider, 'Invalid GlobKurier tracking reply');
  if (httpStatus === 400 && isRecord(body.fields) && clean(body.fields.orderNumber) === 'This value is not valid.') {
    throw new InvalidInputError(provider, 'GlobKurier rejected the booking reference');
  }
  if (httpStatus !== 200 || !Array.isArray(body.statuses)) {
    throw new SchemaError(provider, 'GlobKurier reply lacks its shipment history');
  }
  const events = body.statuses.map(parseEvent);
  const summary = body.latestStatus == null ? undefined : parseEvent(body.latestStatus);
  if (summary?.local_time && !events.some(event => event.local_time === summary.local_time
      && event.provider_code === summary.provider_code && event.description === summary.description && event.location === summary.location)) {
    events.push(summary);
  }
  events.sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const latest = summary ?? events[0];
  if (!latest) throw new NoHistoryError(provider);
  const stage = stageForCode(latest.provider_code ?? '') ?? trackingLanguageStage(latest.description ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: latest.stage_source } : {}),
    ...(latest.provider_code ? { provider_code: latest.provider_code } : {}),
    last_status_text: latest.description ?? null,
    last_update: null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}),
    ...(events.length === 0 ? { summary_only: true } : {}),
    events,
  };
}
