import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'honour-lane-shipping';

export function parseTracking(body: string, container: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Honour Lane requires verification');
  }
  let response: unknown;
  try {
    response = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'Honour Lane did not return tracking JSON');
  }
  if (!isRecord(response) || response.success !== true || response.type !== 'info' || response.msg !== 'success') {
    throw new SchemaError(provider, 'Honour Lane did not return a successful tracking response');
  }
  const { data } = response;
  if (data === null) throw new NotFoundError(provider);
  if (!isRecord(data) || !Array.isArray(data.containerTabVos) || !isRecord(data.containerStatusDetail)) {
    throw new SchemaError(provider, 'Honour Lane omitted the container tracking fields');
  }
  const matches = data.containerTabVos.filter(row => isRecord(row) && row.ctnNo === container);
  const rows: unknown = data.containerStatusDetail[container];
  if (matches.length !== 1 || !Array.isArray(rows)) {
    throw new IndeterminateError(provider, 'Honour Lane omitted a unique history for the requested container');
  }

  const events = (rows as unknown[]).flatMap(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'Honour Lane returned an invalid container milestone');
    const { statusTime, statusName, statusCode, locationName } = row;
    if (statusTime === null) return [];
    if (typeof statusTime !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(statusTime)
        || !DateTime.fromSQL(statusTime, { zone: 'utc' }).isValid || typeof statusName !== 'string'
        || !statusName.trim() || typeof statusCode !== 'string' || !statusCode.trim()) {
      throw new SchemaError(provider, 'Honour Lane returned an invalid actual movement');
    }
    const description = statusName.trim();
    const location = typeof locationName === 'string' ? locationName.trim() : '';
    const stage = scanStage(statusCode);
    return [{
      local_time: statusTime.replace(' ', 'T'), description, provider_code: statusCode,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Honour Lane listed the container without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
