import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isRegionalGofoNumber, isRegionalGofoWaybill, type GofoRegion } from '../../core/detection/gofo.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode, explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { gofoFranceStage } from './status.js';

export { regionalGofoRequestNumber, type GofoRegion } from '../../core/detection/gofo.js';

/** The national waybill families the official support pages describe. */
export function normalizeRegionalGofoNumber(raw: string, region: GofoRegion): string {
  const number = normalizeTrackingNumber(raw);
  if (!isRegionalGofoNumber(number, region)) {
    throw new InvalidInputError(`GOFO ${region}`, 'GOFO requires a supported whole shipment identifier');
  }
  return number;
}

export const normalizeGofoFranceNumber = (raw: string) => normalizeRegionalGofoNumber(raw, 'FR');

function identity(value: unknown, provider: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/.test(value.trim()) || !/\d/.test(value)) {
    throw new SchemaError(provider, 'GOFO returned an invalid shipment identifier');
  }
  return normalizeTrackingNumber(value.trim());
}

function scanClock(value: unknown, provider: string): Pick<CarrierEvent, 'time'> & { local_time?: string; provider_time_text?: string } {
  if (value == null || value === '') return {};
  if (typeof value !== 'string') throw new SchemaError(provider, 'GOFO returned a non-text scan clock');
  const raw = clean(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?)(Z|[+-](?:0\d|1[0-4]):?[0-5]\d)?$/.exec(raw);
  if (!match) {
    if (raw.includes('T') && /(?:Z|[+-][\d:]+)$/i.test(raw)) throw new SchemaError(provider, 'GOFO returned an invalid scan timestamp');
    return raw ? { provider_time_text: raw } : {};
  }
  const local = DateTime.fromISO(match[1]!, { zone: 'UTC' });
  if (!local.isValid) throw new SchemaError(provider, 'GOFO returned an invalid scan date');
  if (!match[2]) return { local_time: local.toISO({ includeOffset: false, suppressMilliseconds: true }) };
  const offset = match[2].replace(':', '');
  if (offset !== 'Z' && Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3)) > 840) {
    throw new SchemaError(provider, 'GOFO returned an invalid scan offset');
  }
  const instant = explicitOffsetTime(raw);
  if (!instant) throw new SchemaError(provider, 'GOFO returned an invalid scan timestamp');
  return { time: instant.iso };
}

export function parseRegionalGofo(payload: unknown, rawNumber: string, region: GofoRegion,
  stageOf: (code: string, description: string) => Stage | undefined): CarrierResult {
  const provider = `GOFO ${region}`;
  const number = normalizeRegionalGofoNumber(rawNumber, region);
  if (!isRecord(payload)) throw new SchemaError(provider);
  if (payload.code !== 200) throw new IndeterminateError(provider, 'GOFO returned an unsuccessful tracking response');
  if (!Array.isArray(payload.data) || !payload.data.every(isRecord)) throw new SchemaError(provider);
  // The public page calls omitted inputs invalid, but the API's empty list
  // cannot distinguish an absent parcel from an incomplete upstream answer.
  if (!payload.data.length) throw new IndeterminateError(provider, 'GOFO returned no matching parcel history');
  if (payload.data.length !== 1) throw new SchemaError(provider, 'GOFO returned ambiguous parcel history');
  const item = payload.data[0]!;
  const waybill = identity(item.waybillNo, provider);
  const reference = identity(item.trackingNumber, provider);
  if (!isRegionalGofoWaybill(waybill, region) || ![waybill, reference].includes(number)
    || /^(?:GF|CI)(?:US|FR|IT|NL|ES)/.test(reference) && (!isRegionalGofoWaybill(reference, region) || reference !== waybill)) {
    throw new SchemaError(provider, 'GOFO returned a different parcel or national network');
  }
  if (countryCode(item.toCountry) !== region) throw new SchemaError(provider, 'GOFO returned a parcel outside the national service');
  if (!Array.isArray(item.trackEventList) || !item.trackEventList.every(isRecord) || item.trackEventList.length > 500) throw new SchemaError(provider);
  const rows = item.trackEventList;
  if (!rows.length) throw new IndeterminateError(provider, 'GOFO returned no parcel scans');
  if (!Number.isInteger(item.trackEventCount) || Number(item.trackEventCount) < rows.length || Number(item.trackEventCount) > 500) {
    throw new IndeterminateError(provider, 'GOFO returned an inconsistent scan count');
  }
  const summary = item.lastTrackEvent;
  if (!isRecord(summary) || ['processCode', 'processDate', 'processContent', 'mainContent', 'processLocation']
    .some(field => summary[field] !== rows[0]![field])) {
    throw new IndeterminateError(provider, 'GOFO latest summary does not match its first scan');
  }
  const events: CarrierEvent[] = [], seen = new Set<string>();
  // Both regional clients render the latest-first list as returned. Equal or
  // unresolved clocks keep this order instead of acquiring an invented zone.
  for (const row of rows) {
    if (row.waybillNo != null && identity(row.waybillNo, provider) !== waybill
      || row.trackingNumber != null && identity(row.trackingNumber, provider) !== reference) {
      throw new SchemaError(provider, 'GOFO returned a scan for a different parcel');
    }
    const code = cleanScalar(row.processCode, 32);
    if (row.mainContent != null && typeof row.mainContent !== 'string' || row.processContent != null && typeof row.processContent !== 'string'
      || row.processLocation != null && typeof row.processLocation !== 'string') throw new SchemaError(provider, 'GOFO returned an invalid scan field');
    const wording = clean(row.mainContent || row.processContent, 500);
    if (!code || !wording) throw new SchemaError(provider, 'GOFO returned an incomplete scan');
    const stage = stageOf(code, wording);
    if (code === '205' && stage !== 'delivered') throw new IndeterminateError(provider, 'GOFO returned contradictory delivery wording');
    // Delivery prose can embed recipient details. Keep its milestone alone;
    // subContent, notices, POD data and unrelated references are not projected.
    const description = code === '205' ? region === 'FR' ? 'Livré' : 'Consegnato' : wording;
    const location = clean(row.processLocation, 160);
    const event: CarrierEvent = { ...scanClock(row.processDate, provider), description, provider_code: code,
      ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const latest = events[0]!, stage = latest.stage as Stage | undefined;
  const service = clean(item.serviceName, 80);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: null, destination_country: region, canonical_tracking_number: waybill,
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}), ...(service ? { service_name: service } : {}),
    ...(Number(item.trackEventCount) > rows.length || events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}

export const parseGofoFrance = (payload: unknown, number: string) => parseRegionalGofo(payload, number, 'FR', gofoFranceStage);
