import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult, CarrierStatus } from '../../core/result/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';

const STAGES = new Map([
  ['1', 'registered'], ['2', 'in_transit'], ['3', 'in_transit'],
  ['4_COURIER', 'out_for_delivery'], ['5_COURIER', 'delivered'],
]);

export function normalizeEvriUkNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z0-9]{16}$/.test(number)) throw new InvalidInputError('Evri UK', 'Evri UK requires a 16-character parcel barcode');
  return number;
}

export function evriUkTrackingUrl(raw: string): string {
  return `https://www.evri.com/track/parcel/${normalizeEvriUkNumber(raw)}/details`;
}

function scanTime(raw: unknown) {
  const text = cleanScalar(raw, 64);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:(?:0\d|1[0-3]):?[0-5]\d|14:?00))$/i.test(text)
    ? explicitOffsetTime(text) : null;
}

/** The redacted anonymous feed contains scans; ownership fields are unnecessary. */
export function parseEvriUk(payload: unknown, raw: string, expectedUrn?: string): CarrierResult {
  const number = normalizeEvriUkNumber(raw);
  if (!isRecord(payload) || !Array.isArray(payload.results) || !Array.isArray(payload.failures)) {
    throw new SchemaError('Evri UK', 'Evri UK returned invalid parcel history');
  }
  if (payload.failures.length || payload.results.length === 0) throw new IndeterminateError('Evri UK', 'Evri UK could not confirm parcel history');
  if (payload.results.length !== 1 || !isRecord(payload.results[0])) throw new SchemaError('Evri UK', 'Evri UK returned ambiguous parcel history');
  const parcel = payload.results[0];
  const identifiers = parcel.parcelIdentifiers;
  if (!Array.isArray(identifiers) || identifiers.length > 50
    || !identifiers.every(id => isRecord(id) && typeof id.type === 'string' && typeof id.value === 'string')) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
  }
  const barcodes = identifiers.filter(id => isRecord(id) && id.type === 'BARCODE');
  if (!barcodes.length || barcodes.some(id => !isRecord(id) || id.value !== number)
    || (expectedUrn !== undefined && parcel.uniqueId !== expectedUrn)) {
    throw new SchemaError('Evri UK', 'Evri UK did not return the requested parcel');
  }
  if (!Array.isArray(parcel.trackingEvents) || parcel.trackingEvents.length > 500) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
  if (!parcel.trackingEvents.length) throw new IndeterminateError('Evri UK', 'Evri UK returned no parcel activity');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const rawEvent of parcel.trackingEvents) {
    if (!isRecord(rawEvent) || !isRecord(rawEvent.trackingPoint) || !isRecord(rawEvent.trackingStage)) {
      throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
    }
    const description = cleanScalar(rawEvent.trackingPoint.description);
    const code = cleanScalar(rawEvent.trackingPoint.trackingPointCode, 64);
    const stageCode = cleanScalar(rawEvent.trackingStage.trackingStageCode, 64);
    if (!description || !code || !stageCode) throw new SchemaError('Evri UK', 'Evri UK returned invalid tracking events');
    const stage = STAGES.get(stageCode);
    const privateDeliveryProse = /\b(?:delivered (?:to|by)|signed (?:for )?by)\b/i.test(description);
    const time = scanTime(rawEvent.dateTime);
    const clock = cleanScalar(rawEvent.dateTime, 64);
    const event: CarrierEvent = {
      ...(time ? { time: time.iso } : clock ? { provider_time_text: clock } : {}),
      description: stage === 'delivered' ? 'Delivered' : privateDeliveryProse ? 'Delivery update' : description,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
      provider_code: code,
      provider_stage_code: stageCode,
    };
    const identity = JSON.stringify([time?.iso ?? clock, code, description]);
    if (!seen.has(identity)) { seen.add(identity); events.push(event); }
  }
  if (!events.some(event => event.time)) throw new IndeterminateError('Evri UK', 'Evri UK returned no dated parcel activity');
  if (events.every(event => event.time)) events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const newest = events[0]!;
  const stage = newest.stage;
  const status: CarrierStatus = stage === 'registered' ? 'pending'
    : stage === 'delivered' || stage === 'out_for_delivery' || stage === 'in_transit' ? stage : 'unknown';
  return {
    status, ...(stage ? { current_stage: stage } : {}), last_status_text: newest.description ?? null,
    last_update: newest.time ?? null, events: events.slice(0, 100),
    tracking_url: evriUkTrackingUrl(number), tracking_source: 'structured-web-response',
  };
}
