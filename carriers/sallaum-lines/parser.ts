import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'sallaum-lines';

const milestones = [
  { field: 'dischargedOn', port: 'pod', description: 'Unit discharged' },
  { field: 'shippedOn', port: 'pol', description: 'Unit shipped' },
  { field: 'receivedOn', port: 'pol', description: 'Unit received' },
] as const;

function localClock(value: unknown): string | undefined {
  const text = clean(value);
  const stamp = DateTime.fromISO(text, { zone: 'utc' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text) || !stamp.isValid || stamp.year < 1950) return undefined;
  return text.endsWith('T00:00:00') ? text.slice(0, 10) : text;
}

export function parseTracking(body: string, number: string, httpStatus: number): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Sallaum Lines requires verification');
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Sallaum Lines did not return cargo JSON');
  }
  if (httpStatus === 404 && isRecord(data) && data.status === 404 && data.title === 'Not Found') {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(data) || typeof data.serialNumber !== 'string') {
    throw new SchemaError(provider, 'Sallaum Lines omitted the tracked vehicle');
  }
  if (clean(data.serialNumber).toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Sallaum Lines returned a different vehicle serial');
  }
  const events = milestones.flatMap(({ field, port, description }) => {
    const date = localClock(data[field]);
    if (!date) return [];
    const location = clean(data[port]);
    return [{
      description, local_time: date, ...(location && { location }),
      stage: scanStages.get(description)!, stage_source: 'carrier_map',
    }];
  }).sort((first, second) => second.local_time.localeCompare(first.local_time));
  const latest = events[0];
  if (!latest) {
    throw new IndeterminateError(provider, 'Sallaum Lines listed the vehicle without dated movements', { reason: 'listed' });
  }
  return {
    status: languageStageStatus(latest.stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}
