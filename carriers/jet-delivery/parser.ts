import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { eventStages, summaryStages } from './status.js';

export const provider = 'jet-delivery';

function datedInstant(value: unknown): string | undefined {
  const text = clean(value);
  if (!/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return undefined;
  return DateTime.fromISO(text, { setZone: true }).isValid ? text : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'Jet Delivery requires verification');
  }

  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Jet Delivery did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Jet Delivery omitted the tracking result');
  if (reply.data === null && isRecord(reply.error) && clean(reply.error.message) === 'Invalid tracking number') {
    throw new NotFoundError(provider);
  }
  if (reply.error !== null || !isRecord(reply.data)) throw new SchemaError(provider, 'Jet Delivery omitted the shipment');
  const guide = reply.data;
  if (clean(guide.track_no) !== number) throw new IndeterminateError(provider, 'Jet Delivery returned a different shipment');

  const code = clean(guide.status_code);
  const wording = clean(guide.status_description);
  const stage = summaryStages.get(code);
  const lastUpdate = datedInstant(guide.status_datetime);
  const events: CarrierEvent[] = [];
  for (const row of Array.isArray(guide.events) ? guide.events as unknown[] : []) {
    if (!isRecord(row)) continue;
    const time = datedInstant(row.datetime);
    if (!time) continue;
    const text = clean(row.description);
    const place = /^(Driver dispatched to|Driver departed from|Drop-off completed in) ([\p{L} .'-]{1,85}, [A-Z]{2}) \d{5}(?:-\d{4})?$/u.exec(text);
    const label = place?.[1] ?? text;
    const location = place?.[2];
    const eventStage = eventStages.get(label);
    if (!location && !eventStage) continue;
    const description = location ? label + ' ' + location : label;
    events.push({
      time, description,
      ...(location && { location }),
      ...(eventStage && { stage: eventStage, stage_source: 'carrier_map' }),
    });
  }
  if (!wording && !events.length) {
    throw new IndeterminateError(provider, 'Jet Delivery listed the shipment without a status or dated activity', { reason: 'listed' });
  }
  events.sort((first, second) => Date.parse(second.time ?? '') - Date.parse(first.time ?? ''));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(code && { provider_code: code }),
    ...(wording && !hasPrivateDeliveryDetails(wording) && { last_status_text: wording }),
    ...(lastUpdate && { last_update: lastUpdate }),
    ...(stage === 'delivered' && lastUpdate && { delivered_at: lastUpdate }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}
