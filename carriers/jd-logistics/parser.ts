import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jdLogisticsStatus } from './status.js';
import { withoutCourierContact } from './wording.js';

const PROVIDER = 'JD Logistics';

export function normalizeJdNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{8,35}$/.test(number)) throw new InvalidInputError(PROVIDER, 'JD Logistics requires a waybill number');
  return number;
}

/** The international website returns one parent reference with its constituent waybills. */
export function parseJdLogistics(payload: unknown, raw: string): CarrierResult {
  const number = normalizeJdNumber(raw);
  if (!isRecord(payload) || payload.code !== 1 || !Array.isArray(payload.data) || payload.data.length > 100) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid tracking response');
  }
  if (!payload.data.length) throw new IndeterminateError(PROVIDER, 'JD Logistics returned no international history');
  if (payload.data.length !== 1 || !isRecord(payload.data[0])
    || normalizeTrackingNumber(clean(payload.data[0].waybillNo, 64)) !== number) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned a different or ambiguous shipment');
  }
  const item = payload.data[0];
  if (item.waybillNum === 0) throw new IndeterminateError(PROVIDER, 'JD Logistics returned no international history');
  if ((item.waybillNum !== undefined && item.waybillNum !== 1)
    || !Array.isArray(item.wayBillTrackItemDtoList) || item.wayBillTrackItemDtoList.length !== 1
    || !isRecord(item.wayBillTrackItemDtoList[0])) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned missing or multiple waybills');
  }
  const waybill = item.wayBillTrackItemDtoList[0];
  if (!clean(waybill.waybillNo, 64) || !Array.isArray(waybill.trackNodeList) || waybill.trackNodeList.length > 1000) {
    throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid waybill history');
  }
  if (!waybill.trackNodeList.length) throw new IndeterminateError(PROVIDER, 'JD Logistics returned no international history');
  const events: CarrierEvent[] = waybill.trackNodeList.map(node => {
    if (!isRecord(node)) throw new SchemaError(PROVIDER);
    // Never keep the courier's name and phone.
    const description = withoutCourierContact(clean(node.operatorDesc, 1000));
    const clock = clean(node.operatorTime, 64);
    if (!description || !clock) throw new SchemaError(PROVIDER, 'JD Logistics returned an incomplete scan');
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(clock)) {
      throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan clock');
    }
    const offset = /[+-](\d{2}):?(\d{2})$/.exec(clock);
    if (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59
      || (Number(offset[1]) === 14 && Number(offset[2]) !== 0))) {
      throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan offset');
    }
    const iso = clock.replace(' ', 'T');
    const instant = explicitOffsetTime(iso);
    const wall = DateTime.fromISO(iso, { zone: 'UTC' });
    if (!wall.isValid) throw new SchemaError(PROVIDER, 'JD Logistics returned an invalid scan clock');
    const location = [clean(node.routeCityName, 200), clean(node.routeCountry, 100)].filter(Boolean).join(', ');
    const code = clean(node.operationCode, 32);
    const mapped = code ? jdLogisticsStatus(code) : undefined;
    const classification = classifyWording(description);
    return { description, ...(instant ? { time: instant.iso } : { local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      ...(location ? { location } : {}), ...(code ? { provider_code: code } : {}),
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' }
        : classification.source !== 'none' ? { stage: classification.stage, stage_source: classification.source } : {}) };
  });
  const seen = new Set<string>();
  const unique = events.filter(event => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, 100);
  const latest = unique[0]!;
  const coded = latest.provider_code ? jdLogisticsStatus(latest.provider_code) : undefined;
  const classified = classifyWording(latest.description!);
  return { status: coded?.status ?? (classified.source !== 'none' ? languageStageStatus(classified.stage) : 'unknown'),
    ...(latest.stage ? { current_stage: latest.stage, current_stage_source: latest.stage_source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(latest.local_time ? { last_update_local: latest.local_time } : {}), events: unique };
}
