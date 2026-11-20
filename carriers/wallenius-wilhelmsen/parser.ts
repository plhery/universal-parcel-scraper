import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { scanStages } from './status.js';

export const provider = 'wallenius-wilhelmsen';

function records(body: string, emptyIsMissing = false): unknown[] {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Wallenius Wilhelmsen requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Visibility did not return tracking JSON');
  }
  if (isRecord(reply) && reply.forceRecaptchaFlag === true) {
    throw new ChallengeError(provider, 'Visibility requests reCAPTCHA');
  }
  if (!isRecord(reply) || reply.successful !== true || reply.responseCode !== 'OK' || !Array.isArray(reply.result)) {
    throw new SchemaError(provider, 'Visibility omitted the cargo results');
  }
  const rows: unknown[] = reply.result;
  if (emptyIsMissing && rows.length === 0 && reply.message === 'No Record Found') throw new NotFoundError(provider);
  return rows;
}

export function cargoRows(body: string, bill: string) {
  const rows = records(body, true);
  if (!rows.length) throw new IndeterminateError(provider, 'Visibility returned no cargo for the bill');
  return rows.map(row => {
    if (!isRecord(row) || clean(row.billNumber) !== bill) {
      throw new IndeterminateError(provider, 'Visibility returned cargo for a different bill');
    }
    return row;
  });
}

function movement(label: unknown, clock: unknown, locationCode: unknown, locationName: unknown): CarrierEvent | undefined {
  const description = clean(label);
  const timestamp = DateTime.fromFormat(clean(clock), 'd-M-yyyy H:mm:ss', { zone: 'utc' });
  if (!description || !timestamp.isValid || hasPrivateDeliveryDetails(description)) return undefined;
  const location = /^[A-Z]{2}[A-Z0-9]{3}$/.test(clean(locationCode)) ? clean(locationName) : '';
  const stage = scanStages.get(description);
  return {
    description, local_time: timestamp.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    ...(location && !hasPrivateDeliveryDetails(location) && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseTracking(rows: ReturnType<typeof cargoRows>, bill: string, transport?: string): CarrierResult {
  const events = new Map<string, CarrierEvent>();
  const add = (event: CarrierEvent | undefined) => {
    if (event) events.set(JSON.stringify([event.local_time, event.description, event.location]), event);
  };
  for (const row of rows) {
    add(movement(row.currentStatusDesc, row.currentDateTime, row.currentLocation, row.currentLocationDesc));
  }
  if (transport) {
    for (const row of records(transport)) {
      if (!isRecord(row) || clean(row.billOfLandingNum) !== bill) {
        throw new IndeterminateError(provider, 'Visibility returned transport for a different bill');
      }
      add(movement(row.orginStatus, row.orginStatusDate, row.orginCode, row.origin));
      add(movement(row.destinationStatus, row.destinationStatusDate, row.dstinationCode, row.destination));
    }
  }
  const history = [...events.values()].sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const labels = new Set(rows.map(row => clean(row.currentStatusDesc)));
  const label = labels.size === 1 ? [...labels][0] : 'Mixed cargo statuses';
  const stage = label ? scanStages.get(label) : undefined;
  if (!history.length && !stage) {
    throw new IndeterminateError(provider, 'Visibility listed cargo without dated movements or a known status', { reason: 'listed' });
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(label && !hasPrivateDeliveryDetails(label) && { last_status_text: label }),
    ...(history.length ? { events: history, last_update_local: history[0]?.local_time } : { summary_only: true }),
  };
}
