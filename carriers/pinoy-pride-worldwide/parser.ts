import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { adminStates, scanStages } from './status.js';

export const provider = 'pinoy-pride-worldwide';

export function parseTracking(body: string, invoice: string, httpStatus: number): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource|verify (?:that )?you are human/i.test(body)) {
    throw new ChallengeError(provider, 'Pinoy Pride Worldwide requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    throw new SchemaError(provider, 'Pinoy Pride Worldwide did not return tracking JSON');
  }
  if (httpStatus === 404 && isRecord(reply) && reply.success === false
      && reply.message === 'No shipment found with the provided tracking number.') {
    throw new NotFoundError(provider);
  }
  if (httpStatus !== 200 || !isRecord(reply) || reply.success !== true || !isRecord(reply.data)) {
    throw new SchemaError(provider, 'Pinoy Pride Worldwide omitted its invoice response');
  }
  const data = reply.data;
  if (clean(data.invoice_number).toUpperCase() !== invoice) {
    throw new IndeterminateError(provider, 'Pinoy Pride Worldwide returned a different invoice');
  }
  if (!Array.isArray(data.tracking_history)) throw new SchemaError(provider, 'Pinoy Pride Worldwide omitted its movement history');

  const events = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const row of data.tracking_history as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(provider, 'Pinoy Pride Worldwide returned an invalid movement');
    const code = clean(row.status);
    const description = clean(row.status_label);
    if (adminStates.has(code) || hasPrivateDeliveryDetails(description)) continue;
    const clock = DateTime.fromFormat(clean(row.created_at), 'LLLL d, yyyy hh:mm a', { zone: 'utc', locale: 'en' });
    if (!code || !description || !clock.isValid) {
      throw new SchemaError(provider, 'Pinoy Pride Worldwide returned an invalid movement label or time');
    }
    const localTime = clock.toFormat("yyyy-MM-dd'T'HH:mm");
    const stage = scanStages.get(code);
    events.set(JSON.stringify([code, localTime, description]), {
      local_time: localTime, description, provider_code: code,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }

  const history = [...events.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const latest = history[0];
  if (!latest) throw new IndeterminateError(provider, 'Pinoy Pride Worldwide listed the invoice without dated movements', { reason: 'listed' });
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events: history,
  };
}
