import { isExpedicoReference } from '../../core/detection/expedico.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, explicitOffsetTime, EXPLICIT_OFFSET_PATTERN } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { expedicoStage } from './status.js';

export const PROVIDER = 'Expedico';
export const EXPEDICO_ENDPOINT = 'https://expedico.eu/api/public';
export const EXPEDICO_QUERY = `query tracking($codes: [String]!) {
  tracking(codes: $codes) {
    id code trackingCode result parcelWeightKg
    packetState { sys }
    carrier { id labelLocal }
    events { carrierStateDescription packetState { sys } occuredOn }
  }
}`;

export function normalizeExpedicoNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Expedico needs a parcel reference');
  if (!isExpedicoReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function identity(row: JsonObject, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length > 64) throw new SchemaError(PROVIDER, 'Expedico returned an invalid parcel identity');
  return normalizeTrackingNumber(value);
}

function code(value: unknown): string {
  if (!isRecord(value) || typeof value.sys !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value.sys)) throw new SchemaError(PROVIDER, 'Expedico returned an invalid state');
  return value.sys;
}

function clock(value: unknown): Pick<CarrierEvent, 'time' | 'local_time'> {
  if (typeof value !== 'string' || value.length > 64) throw new SchemaError(PROVIDER, 'Expedico returned an invalid scan clock');
  if (EXPLICIT_OFFSET_PATTERN.test(value)) {
    const instant = explicitOffsetTime(value);
    if (!instant) throw new SchemaError(PROVIDER, 'Expedico returned an invalid scan offset');
    return { time: instant.iso };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T]((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)$/.exec(value);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Expedico returned an invalid local clock');
  return { local_time: `${match[1]}-${match[2]}-${match[3]}T${match[4]}` };
}

function description(raw: unknown, state: string): string {
  if (raw !== null && raw !== undefined && (typeof raw !== 'string' || raw.length > 2000)) throw new SchemaError(PROVIDER, 'Expedico returned an invalid scan description');
  const text = typeof raw === 'string' ? clean(raw) : '', wording = text.replace(/^Received code:\s*/, '');
  // Partner comments can contain recipient details. Retain the logistics activities, not arbitrary comments.
  if (['Arrived at Delivery Hub', 'Out for delivery', 'Parcel was picked up', 'Delivered'].includes(wording)
    || /^HUB International [\p{L} .'-]{1,100} - Arrival in HUB$/u.test(wording)) return text;
  return state.replace(/_/g, ' ');
}

export function parseExpedico(payload: unknown, raw: string): CarrierResult {
  const number = normalizeExpedicoNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Expedico returned no tracking envelope');
  if (payload.errors !== undefined) {
    if (!Array.isArray(payload.errors)) throw new SchemaError(PROVIDER, 'Expedico returned an invalid error envelope');
    if (payload.errors.length) {
      const messages = payload.errors.slice(0, 10).map(value => isRecord(value) && typeof value.message === 'string' ? value.message.slice(0, 500) : '').join(' ');
      if (/rate limit|too many requests|throttl/i.test(messages)) throw new RateLimitedError(PROVIDER);
      if (/captcha|verification|blocked/i.test(messages)) throw new ChallengeError(PROVIDER, 'Expedico requires verification');
      throw new IndeterminateError(PROVIDER, 'Expedico did not complete the lookup');
    }
  }
  if (!isRecord(payload.data) || !Array.isArray(payload.data.tracking) || payload.data.tracking.length !== 1) throw new SchemaError(PROVIDER, 'Expedico returned no unique tracking record');
  const record: unknown = payload.data.tracking[0];
  if (!isRecord(record) || identity(record, 'code') !== number) throw new SchemaError(PROVIDER, 'Expedico returned another requested reference');
  if (record.result === 'NOT_FOUND') {
    if (record.id === null && record.trackingCode === null && record.carrier === null && record.packetState === null
      && record.events === null) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Expedico returned a mixed absence record');
  }
  if (record.result !== 'FOUND') throw new IndeterminateError(PROVIDER, 'Expedico did not complete the parcel lookup');
  const own = identity(record, 'id'), partner = identity(record, 'trackingCode');
  if (!/^\d{13}$/.test(own) || !/^[A-Z0-9]{5,40}$/.test(partner) || (number !== own && number !== partner)
    || !isRecord(record.carrier) || typeof record.carrier.id !== 'string' || typeof record.carrier.labelLocal !== 'string'
    || record.carrier.labelLocal.length > 200 || !Array.isArray(record.events) || record.events.length > 500) {
    throw new SchemaError(PROVIDER, 'Expedico returned an unbound parcel or invalid history');
  }
  const summary = code(record.packetState);
  if (!record.events.length) throw new NoHistoryError(PROVIDER, 'Expedico returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of [...record.events as unknown[]].reverse()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Expedico returned an invalid scan');
    const state = code(row.packetState), wording = description(row.carrierStateDescription, state), stage = expedicoStage(state, wording);
    const event: CarrierEvent = { ...clock(row.occuredOn), description: wording, provider_code: state,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const newest = events[0]!;
  if (newest.provider_code !== summary) throw new SchemaError(PROVIDER, 'Expedico returned a contradictory current state');
  let weight: number | undefined;
  if (record.parcelWeightKg !== null && record.parcelWeightKg !== undefined) {
    const value = record.parcelWeightKg;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+(?:\.\d{1,3})?$/.test(String(value))
      || !Number.isFinite(Number(value)) || Number(value) > 1_000_000) throw new SchemaError(PROVIDER, 'Expedico returned an invalid parcel weight');
    weight = Number(value);
  }
  const stage = expedicoStage(summary, newest.description!);
  // The portal names this national service explicitly. The full partner reference stays unchanged.
  const fan = record.carrier.id === '180' && record.carrier.labelLocal === 'RO Fan';
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    provider_code: summary, last_status_text: newest.description, last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}), expected_delivery: null,
    ...(weight !== undefined ? { weight_kg: weight } : {}), ...(fan ? { delivery_carrier: 'fan-courier' } : {}), delivery_tracking_number: partner,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
