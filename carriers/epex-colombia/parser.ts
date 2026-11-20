import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'epex-colombia';

function localTime(value: unknown): string | undefined {
  const time = DateTime.fromFormat(clean(value), 'd/M/yyyy H:mm:ss', { zone: 'utc' });
  return time.isValid ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'EPEX requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'EPEX did not return tracking JSON');
  }
  if (!isRecord(reply) || reply.ok !== true || !isRecord(reply.parsed)) {
    throw new SchemaError(provider, 'EPEX omitted the tracking data');
  }
  const payload = reply.parsed;
  if (isRecord(payload.ERROR) && clean(payload.ERROR.CODIGO) === '400'
    && clean(payload.ERROR.MENSAJE).endsWith("'" + number + "' no existe")) {
    throw new NotFoundError(provider);
  }
  const guide = payload.EXPEDICION;
  if (!isRecord(guide)) throw new SchemaError(provider, 'EPEX omitted the guide');
  if (clean(guide.NUMERO) !== number) throw new IndeterminateError(provider, 'EPEX returned a different guide');

  const label = clean(guide.ESTADO);
  const currentStage = scanStages.get(label);
  const currentTime = localTime(guide.FECHAESTADO);
  const scans = isRecord(guide.TRACKINGS) ? guide.TRACKINGS.TRACKING : undefined;
  const events: CarrierEvent[] = [];
  for (const scan of Array.isArray(scans) ? scans as unknown[] : [scans]) {
    if (!isRecord(scan)) continue;
    const description = clean(scan.ESTADO);
    const time = localTime(scan.FECHA);
    if (!description || !time || hasPrivateDeliveryDetails(description)) continue;
    const stage = scanStages.get(description);
    events.push({ description, local_time: time, ...(stage && { stage, stage_source: 'carrier_map' }) });
  }
  if (!events.length && !currentStage) {
    throw new IndeterminateError(provider, 'EPEX listed the guide without a mapped status or dated movements', { reason: 'listed' });
  }
  events.reverse().sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  return {
    status: currentStage ? languageStageStatus(currentStage) : 'unknown',
    ...(currentStage && { current_stage: currentStage, current_stage_source: 'carrier_map' }),
    ...(label && !hasPrivateDeliveryDetails(label) && { last_status_text: label }),
    ...(currentTime && { last_update_local: currentTime }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}
