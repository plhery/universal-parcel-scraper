import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { containerMovements, scanMeaning } from './status.js';

export const provider = 'cordelia-shipping';

export function parseTracking(body: string, number: string, container: boolean): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Cordelia requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Cordelia did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Cordelia returned an invalid tracking reply');
  if (container && reply.success === false && reply.searchList === null && reply.message === 'Invalid Container Number !') {
    throw new InvalidInputError(provider, 'Cordelia rejected this container number');
  }
  if (!Array.isArray(reply.searchList) || reply.success === false) {
    throw new SchemaError(provider, 'Cordelia did not return a successful tracking list');
  }
  if (reply.searchList.length === 0) throw new NotFoundError(provider);
  const key = container ? 'containerNo' : 'blNo';
  const matches = reply.searchList.filter(row => isRecord(row) && row[key] === number);
  const summary: unknown = matches[0];
  if (matches.length !== 1 || !isRecord(summary)) {
    throw new IndeterminateError(provider, 'Cordelia did not identify one exact reference');
  }

  const details = reply[container ? 'conlist' : 'conListList'];
  const matchingDetails = Array.isArray(details)
    ? details.filter(row => isRecord(row) && (container ? row.containerNo === number : summary.noOfCon === 1))
    : [];
  const detail: unknown = matchingDetails.length === 1 ? matchingDetails[0] : undefined;
  const events = isRecord(detail) ? containerMovements.flatMap(movement => {
    const date = detail[movement.field];
    if (date === null || date === undefined || date === '') return [];
    const clock = typeof date === 'string' ? DateTime.fromFormat(date, 'dd/MM/yyyy HH:mm', { zone: 'utc' }) : null;
    if (!clock?.isValid) throw new SchemaError(provider, 'Cordelia returned an invalid movement clock');
    return [{
      local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm"),
      description: movement.description,
      provider_code: movement.code,
      ...(movement.stage && { stage: movement.stage, stage_source: 'carrier_map' }),
    }];
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time)) : [];

  const latest = events[0];
  const code = typeof summary.containerStatusCode === 'string' ? summary.containerStatusCode.trim() : '';
  const rawDescription = typeof summary.containerStatusDescription === 'string' ? summary.containerStatusDescription.trim() : '';
  const meaning = scanMeaning(code);
  const description = meaning?.description ?? (rawDescription || latest?.description);
  if (!description) throw new IndeterminateError(provider, 'Cordelia listed the reference without a cargo status', { reason: 'listed' });
  const stage = meaning?.stage ?? events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: description,
    ...(code && { provider_code: code }),
    ...(latest?.provider_code === code && { last_update_local: latest.local_time }),
    ...(!latest && { summary_only: true }), events,
  };
}
