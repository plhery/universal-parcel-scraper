import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { classifyWording, languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';

const PROVIDER = 'CNE Express';
const WORDING: Readonly<Record<string, Stage>> = {
  'Parcel Infomation Received': 'registered', 'Picked Up by Courier': 'accepted',
  'Shipment Loaded': 'in_transit', 'Departed CNE Facility': 'in_transit',
  'Arrived at CNE Facility': 'in_transit', 'Inbound scan': 'in_transit',
  'Shipment Processed': 'in_transit', 'Sorting failed []': 'exception',
  "It was returned to customer's address by CNE": 'returned',
};

export function normalizeCneNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^[A-Z0-9]{6,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'CNE requires an alphanumeric parcel reference');
  return number;
}

function scanTime(value: string) {
  const match = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](\d{2}):?(\d{2}))$/i.exec(value);
  if (!match || (match[1] !== undefined && (Number(match[1]) > 14 || Number(match[2]) > 59
    || (Number(match[1]) === 14 && Number(match[2]) !== 0)))) return null;
  return explicitOffsetTime(value);
}

function scan(raw: unknown): CarrierEvent {
  if (!isRecord(raw) || !clean(raw.details, 1000)) throw new SchemaError(PROVIDER, 'CNE returned an invalid movement');
  const description = clean(raw.details, 1000), clock = clean(raw.date, 64);
  const location = clean(raw.place, 200), stage = WORDING[description];
  const mapped = stage ? { stage, source: 'carrier_map' } : classifyWording(description, 'pending');
  const time = scanTime(clock);
  return { description, ...(location ? { location } : {}),
    ...(time ? { time: time.iso } : clock ? { provider_time_text: clock } : {}),
    ...(mapped.source !== 'none' ? { stage: mapped.stage, stage_source: mapped.source } : {}),
    ...(cleanScalar(raw.state) ? { provider_code: cleanScalar(raw.state) } : {}) };
}

export function parseCne(payload: unknown, raw: string): CarrierResult {
  const number = normalizeCneNumber(raw);
  if (!isRecord(payload) || typeof payload.ReturnValue !== 'number') throw new SchemaError(PROVIDER, 'CNE returned an invalid envelope');
  if (payload.ReturnValue !== 1) {
    if (payload.ReturnValue === 0 && payload.cMess === '订单不存在'
      && payload.Response_Info === undefined && payload.trackingEventList === undefined) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'CNE did not complete the lookup');
  }
  const identity = payload.Response_Info;
  if (!isRecord(identity) || clean(identity.trackingNbr) !== number) throw new SchemaError(PROVIDER, 'CNE returned a different shipment');
  // These are echoed source identifiers, unlike referNbr and transNbr, which
  // may be merchant and downstream references. Do not follow those aliases.
  if (identity.Number_t !== undefined && clean(identity.Number_t) !== number) throw new SchemaError(PROVIDER, 'CNE returned conflicting shipment identifiers');
  if (!Array.isArray(payload.trackingEventList) || payload.trackingEventList.length > 1000) throw new SchemaError(PROVIDER, 'CNE returned an invalid history');
  if (!payload.trackingEventList.length) throw new IndeterminateError(PROVIDER, 'CNE returned no shipment movements');
  // The official client reverses the oldest-first array. Preserve that order
  // even when its unqualified cross-border clocks cannot resolve to instants.
  const events = payload.trackingEventList.map(scan).reverse();
  const latest = events[0]!;
  const summaryStage = cleanScalar(identity.status) === '8' ? 'returned' : undefined;
  const stage = summaryStage ?? latest.stage;
  const source = summaryStage ? 'carrier_map' : latest.stage_source;
  const country = clean(identity.Destination, 64).toUpperCase();
  return { status: stage ? languageStageStatus(stage as Stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: source } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null,
    ...(stage === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}), events: events.slice(0, 100) };
}
