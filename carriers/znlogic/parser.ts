import { isZnlogicReference } from '../../core/detection/znlogic.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay, countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { znlogicStage } from './status.js';

export const PROVIDER = 'Zinc';
export const ZNLOGIC_BASE = 'https://tracking.link/api/tracking/';

export function normalizeZnlogicNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Zinc needs a parcel reference');
  if (!isZnlogicReference(number)) throw new NoHistoryError(PROVIDER, 'The guest lookup does not support this reference', { reason: 'unsupported_reference' });
  return number;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || value.length > limit) throw new SchemaError(PROVIDER, 'Zinc returned an invalid tracking field');
  return clean(value, limit);
}

function clock(value: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\.\d{3})?$/.exec(text(value, 64));
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))) throw new SchemaError(PROVIDER, 'Zinc returned an invalid local scan clock');
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
}

function description(value: unknown): string {
  const raw = text(value).replace(/\s*\([^()]*\)\s*$/, '');
  const wording = raw.split(/https?:\/\/|\b(?:recipient|consignee|signed\s+by|received\s+by|phone|tracking\s+(?:number|#))\s*[:：]?/i, 1)[0]!.trim();
  if (!wording || /[<>@]|\+\d[\d ()-]{6,}|\d{5,}/.test(wording)) throw new SchemaError(PROVIDER, 'Zinc returned no logistics description');
  return wording;
}

function location(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const place = text(value, 250).replace(/\b\d{5}(?:-\d{4})?\b/g, '').replace(/[ ,]+$/, '').trim();
  return /[<>@]|https?:|\d{7,}|\b(?:recipient|phone|street|road|avenue|apartment|address)\b/i.test(place) ? '' : place;
}

/** Positives are bound by the exact same-origin request path; only negatives echo an id. */
export function parseZnlogic(payload: unknown, raw: string, httpStatus = 200): CarrierResult {
  const number = normalizeZnlogicNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Zinc returned no tracking envelope');
  if (payload.error !== undefined) {
    if (payload.history !== undefined || payload.status !== undefined) throw new SchemaError(PROVIDER, 'Zinc returned a mixed error and shipment');
    const error = payload.error;
    if (httpStatus === 404 && isRecord(error) && error.code === 'not_found' && isRecord(error.details) && error.details.resource === 'Shipment') {
      if (error.details.id !== number || error.message !== `Shipment with ID '${number}' not found`) throw new SchemaError(PROVIDER, 'Zinc returned another requested reference');
      throw new NotFoundError(PROVIDER);
    }
    if (httpStatus === 404) throw new TransportError(PROVIDER, 'Zinc tracking route is unavailable', { status: 404 });
    throw new IndeterminateError(PROVIDER, 'Zinc did not complete the lookup');
  }
  if (httpStatus !== 200) throw new TransportError(PROVIDER, 'Zinc tracking route is unavailable', { status: httpStatus });
  if (payload.tracking_id !== undefined && payload.tracking_id !== number) throw new SchemaError(PROVIDER, 'Zinc returned another requested reference');
  if (!text(payload.status, 250) || !Array.isArray(payload.history) || payload.history.length > 500) throw new SchemaError(PROVIDER, 'Zinc returned no shipment history');
  if (!payload.history.length) throw new NoHistoryError(PROVIDER, 'Zinc returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of payload.history as unknown[]) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Zinc returned an invalid scan');
    const wording = description(row.message), stage = znlogicStage(null, wording), place = location(row.location);
    const event: CarrierEvent = { local_time: clock(row.time), description: wording,
      ...(place ? { location: place } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const newest = events[0]!, stage = znlogicStage(null, newest.description!);
  const summary = payload.last_update_summary === undefined ? '' : text(payload.last_update_summary, 250);
  const summaryStage = znlogicStage(null, summary);
  if (summaryStage && stage && summaryStage !== stage) throw new SchemaError(PROVIDER, 'Zinc returned contradictory current states');
  if (/^Delivered(?:\s|$)/i.test(text(payload.status, 250)) && stage && stage !== 'delivered') throw new SchemaError(PROVIDER, 'Zinc returned contradictory delivery states');
  const origin = payload.origin === undefined ? null : countryCode(text(payload.origin, 100));
  const destination = payload.destination === undefined ? null : countryCode(text(payload.destination, 100));
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    ...(origin ? { origin_country: origin } : {}), ...(destination ? { destination_country: destination } : {}),
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}
