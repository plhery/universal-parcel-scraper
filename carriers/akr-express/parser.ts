import { NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, trackingLanguageStage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { statusForCode } from './status.js';

export const provider = 'akr-express';
export const referencePattern = /^[A-Z][0-9]{6,7}$/;

function parseEvent(value: unknown, bookedOn: string): CarrierEvent | undefined {
  if (!isRecord(value)) throw new SchemaError(provider, 'Invalid AKR Express movement record');
  const code = cleanScalar(value.title, 120);
  if (!code) throw new SchemaError(provider, 'AKR Express movement has no title');
  const rawClock = clean(value.time, 80);
  // The tracker displays a current-status card in the timeline. Its clock can repeat the booking clock.
  if (value.live === true && /^\d+$/.test(code) && rawClock === bookedOn) return undefined;
  const clock = zonedTime(rawClock, 'EEE dd/MM/yyyy · hh:mm a', 'Asia/Kolkata', { locale: 'en' });
  const location = clean(value.loc, 120);
  const mapped = statusForCode(code);
  const stage = mapped?.stage ?? trackingLanguageStage(code);
  return {
    provider_code: code, description: mapped?.wording ?? code,
    ...(clock ? { time: clock.iso } : rawClock && rawClock !== 'NA' ? { local_time: rawClock } : {}),
    ...(location && location !== 'NA' ? { location } : {}),
    ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
  };
}

export function parseTracking(body: unknown, httpStatus: number): CarrierResult {
  if (!isRecord(body)) throw new SchemaError(provider, 'Invalid AKR Express tracking reply');
  if (httpStatus === 404 && body.status === 'error'
    && /^LR number not found\./i.test(clean(body.message))) throw new NotFoundError(provider);
  if (httpStatus !== 200 || body.status !== 'success' || !isRecord(body.data) || !Array.isArray(body.data.timeline)) {
    throw new SchemaError(provider, 'AKR Express reply lacks a shipment timeline');
  }
  const data = body.data;
  const bookedOn = clean(data.bookedOn, 80);
  const events = body.data.timeline.flatMap(value => {
    const event = parseEvent(value, bookedOn);
    return event ? [event] : [];
  });
  if (events.length === 0) throw new NoHistoryError(provider);
  const code = clean(data.status, 80);
  const label = clean(data.statusLabel, 120);
  const mapped = statusForCode(code);
  const stage = mapped?.stage ?? trackingLanguageStage(label || code);
  const update = events.find(event => event.time);
  const delivery = stage === 'delivered' ? events.find(event => event.stage === 'delivered' && event.time) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
    ...(code ? { provider_code: code } : {}),
    last_status_text: mapped?.wording ?? (label || code || null),
    last_update: update?.time ?? null,
    ...(delivery?.time ? { delivered_at: delivery.time } : {}),
    events,
  };
}
